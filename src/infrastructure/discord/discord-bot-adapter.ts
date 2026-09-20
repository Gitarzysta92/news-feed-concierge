import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Guild,
  type Interaction,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import type { DeliverFeed } from "../../application/deliver-feed.js";
import type { SubmitFeedback } from "../../application/submit-feedback.js";
import type { RankedArticle, DeliveryReason } from "../../domain/model.js";
import { REACTIONS, reactionDefinition } from "../../domain/reactions.js";
import type { ConciergeRepository, DeliveryEdge, LlmEvaluator } from "../../domain/ports.js";

const PUBLISH_PERMISSIONS = [
  { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
  { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
  { flag: PermissionFlagsBits.EmbedLinks, label: "Embed Links" },
  { flag: PermissionFlagsBits.AddReactions, label: "Add Reactions" },
  { flag: PermissionFlagsBits.ReadMessageHistory, label: "Read Message History" },
] as const;

export interface DiscordBotDependencies {
  config: {
    token?: string;
  };
  deliverFeed: Pick<DeliverFeed, "execute">;
  submitFeedback: Pick<SubmitFeedback, "execute">;
  repository: Pick<
    ConciergeRepository,
    "stats" | "findDeliveryByMessageId" | "upsertDeliveryTarget" | "removeDeliveryTarget"
  >;
  llm: Pick<LlmEvaluator, "enabled">;
}

export class DiscordBotAdapter implements DeliveryEdge {
  readonly key = "discord";
  private client = this.createClient();
  private stopped = false;

  constructor(private readonly dependencies: DiscordBotDependencies) {}

  get connected() {
    return this.client.isReady();
  }

  async start(): Promise<void> {
    const token = this.dependencies.config.token?.trim();
    if (!token) {
      console.warn("Discord edge is disabled because DISCORD_BOT_TOKEN is empty");
      return;
    }
    void this.maintainConnection(token);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.client.destroy();
  }

  private createClient() {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });
    client.on(Events.Error, (error) => console.error("Discord client error", error));
    client.on(Events.Warn, (message) => console.warn("Discord warning", message));
    client.on(Events.InteractionCreate, (interaction) => void this.onInteraction(interaction));
    client.on(Events.MessageReactionAdd, (reaction, user) => void this.onReaction(reaction, user));
    client.on(Events.GuildCreate, (guild) => void this.onGuildInstalled(guild));
    client.on(Events.ClientReady, (readyClient) => void this.onClientReady(readyClient));
    return client;
  }

  private async onClientReady(client: Client<true>) {
    try {
      const guildIds = [...client.guilds.cache.keys()];
      await Promise.all(guildIds.map((guildId) => this.registerCommands(guildId)));
      console.log(`Discord edge connected as ${client.user.tag} in ${guildIds.length} guild(s)`);
    } catch (error) {
      console.error("Discord command registration failed", error);
    }
  }

  private async maintainConnection(token: string) {
    let delayMs = 2_000;
    while (!this.stopped) {
      try {
        await this.client.login(token);
        return;
      } catch (error) {
        console.error("Discord login failed; retrying", error);
        this.client.destroy();
        if (this.stopped) return;
        this.client = this.createClient();
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 30_000);
      }
    }
  }

  async publish(channelId: string, item: RankedArticle, reason: DeliveryReason): Promise<string> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`Discord channel ${channelId} is not sendable`);
    const percent = Math.round(item.finalScore * 100);
    const embed = new EmbedBuilder()
      .setColor(0xff5e3a)
      .setTitle(item.article.title.slice(0, 256))
      .setURL(item.article.url)
      .setDescription((item.article.summary || item.reason).slice(0, 1000))
      .addFields(
        { name: "Why this", value: item.reason.slice(0, 1024) },
        { name: "Fit", value: `${percent}%`, inline: true },
        { name: "Source", value: item.article.sourceLabel, inline: true },
        { name: "Delivery", value: reason, inline: true },
      )
      .setFooter({ text: "React to teach this channel's feed" })
      .setTimestamp(new Date(item.article.publishedAt));
    if (item.article.imageUrl) embed.setThumbnail(item.article.imageUrl);
    const message = await channel.send({ embeds: [embed] });
    for (const definition of REACTIONS) await message.react(definition.reaction);
    return message.id;
  }

  private async registerCommands(guildId: string): Promise<void> {
    const application = this.client.application;
    if (!application) throw new Error("Discord application was not available after login");
    const commands = [
      new SlashCommandBuilder()
        .setName("news")
        .setDescription("Ask the concierge for fresh, channel-ranked technical news")
        .addIntegerOption((option) => option
          .setName("count")
          .setDescription("Number of articles (1–5)")
          .setMinValue(1)
          .setMaxValue(5)),
      new SlashCommandBuilder()
        .setName("concierge-status")
        .setDescription("Show collection and learning status"),
      new SlashCommandBuilder()
        .setName("concierge-delivery")
        .setDescription("Configure scheduled concierge delivery for this channel")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addSubcommand((command) => command
          .setName("enable")
          .setDescription("Enable scheduled article delivery in this channel"))
        .addSubcommand((command) => command
          .setName("disable")
          .setDescription("Disable scheduled article delivery in this channel")),
    ].map((command) => command.toJSON());
    await application.commands.set(commands, guildId);
  }

  private async onGuildInstalled(guild: Guild): Promise<void> {
    try {
      await this.registerCommands(guild.id);
      console.log(`Registered concierge commands for Discord guild ${guild.name} (${guild.id})`);
    } catch (error) {
      console.error(`Discord command registration failed for guild ${guild.id}`, error);
    }
  }

  private async onInteraction(interaction: Interaction) {
    if (!interaction.isChatInputCommand()) return;
    const channelName = interaction.channel && "name" in interaction.channel
      ? String(interaction.channel.name)
      : interaction.channelId;

    try {
      if (interaction.commandName === "news") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const missingPermissions = interaction.appPermissions
          ? PUBLISH_PERMISSIONS
              .filter(({ flag }) => !interaction.appPermissions?.has(flag))
              .map(({ label }) => label)
          : [];
        if (missingPermissions.length > 0) {
          await interaction.editReply(
            `I can't publish in <#${interaction.channelId}>. Grant the bot: **${missingPermissions.join(", ")}**.`,
          );
          return;
        }
        const count = interaction.options.getInteger("count") ?? 1;
        const delivered = await this.dependencies.deliverFeed.execute({
          channelId: interaction.channelId,
          channelName,
          edge: this,
          reason: "command",
          count,
        });
        await interaction.editReply(delivered.length
          ? `Delivered ${delivered.length} fresh ${delivered.length === 1 ? "article" : "articles"}.`
          : "Nothing fresh is waiting—this channel has already seen the current candidates.");
        return;
      }

      if (interaction.commandName === "concierge-status") {
        const stats = await this.dependencies.repository.stats();
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: [
            `Collected: **${stats.articles}**`,
            `Full text: **${stats.extracted}**`,
            `Feedback signals: **${stats.feedback}**`,
            `Delivered: **${stats.deliveries}**`,
            `LLM: **${this.dependencies.llm.enabled ? "enabled" : "disabled"}**`,
          ].join(" · "),
        });
        return;
      }

      if (interaction.commandName === "concierge-delivery") {
        if (!interaction.guildId || !interaction.channel?.isSendable()) {
          await interaction.reply({
            flags: MessageFlags.Ephemeral,
            content: "Scheduled delivery can only be configured in a server text channel.",
          });
          return;
        }
        const action = interaction.options.getSubcommand();
        if (action === "enable") {
          await this.dependencies.repository.upsertDeliveryTarget({
            interface: this.key,
            channelId: interaction.channelId,
            channelName,
            installationId: interaction.guildId,
          });
          await interaction.reply({
            flags: MessageFlags.Ephemeral,
            content: `Scheduled concierge delivery is now enabled in <#${interaction.channelId}>.`,
          });
          return;
        }
        const removed = await this.dependencies.repository.removeDeliveryTarget(this.key, interaction.channelId);
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: removed
            ? `Scheduled concierge delivery is now disabled in <#${interaction.channelId}>.`
            : `Scheduled concierge delivery was not enabled in <#${interaction.channelId}>.`,
        });
      }
    } catch (error) {
      console.error("Discord command failed", error);
      const message = "The concierge hit a temporary error. Please try again shortly.";
      if (interaction.deferred || interaction.replied) await interaction.editReply(message);
      else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  }

  private async onReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ) {
    if (user.bot) return;
    try {
      if (reaction.partial) await reaction.fetch();
      const emoji = reaction.emoji.name ?? "";
      const definition = reactionDefinition(emoji);
      if (!definition) return;
      const delivery = await this.dependencies.repository.findDeliveryByMessageId(reaction.message.id);
      if (!delivery) return;
      const channel = reaction.message.channel;
      const channelName = "name" in channel ? String(channel.name) : delivery.channelId;
      await this.dependencies.submitFeedback.execute({
        channelId: delivery.channelId,
        channelName,
        articleId: delivery.articleId,
        userId: user.id,
        userName: user.globalName ?? user.username ?? undefined,
        reaction: definition.reaction,
        interface: "discord",
      });
    } catch (error) {
      console.error("Discord reaction feedback failed", error);
    }
  }
}
