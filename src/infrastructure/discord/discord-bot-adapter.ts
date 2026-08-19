import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
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

export interface DiscordBotDependencies {
  config: {
    token?: string;
    guildId?: string;
  };
  deliverFeed: Pick<DeliverFeed, "execute">;
  submitFeedback: Pick<SubmitFeedback, "execute">;
  repository: Pick<ConciergeRepository, "stats" | "findDeliveryByMessageId">;
  llm: Pick<LlmEvaluator, "enabled">;
}

export class DiscordBotAdapter implements DeliveryEdge {
  readonly key = "discord";
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  constructor(private readonly dependencies: DiscordBotDependencies) {
    this.client.on(Events.InteractionCreate, (interaction) => void this.onInteraction(interaction));
    this.client.on(Events.MessageReactionAdd, (reaction, user) => void this.onReaction(reaction, user));
  }

  async start(): Promise<void> {
    const token = this.dependencies.config.token;
    if (!token) throw new Error("DISCORD_BOT_TOKEN is required when Discord is enabled");
    const ready = new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, async (client) => {
        await this.registerCommands();
        console.log(`Discord edge connected as ${client.user.tag}`);
        resolve();
      });
    });
    await this.client.login(token);
    await ready;
  }

  async stop(): Promise<void> {
    this.client.destroy();
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

  private async registerCommands(): Promise<void> {
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
    ].map((command) => command.toJSON());
    const guildId = this.dependencies.config.guildId;
    if (guildId) await application.commands.set(commands, guildId);
    else await application.commands.set(commands);
  }

  private async onInteraction(interaction: Interaction) {
    if (!interaction.isChatInputCommand()) return;
    const channelName = interaction.channel && "name" in interaction.channel
      ? String(interaction.channel.name)
      : interaction.channelId;

    try {
      if (interaction.commandName === "news") {
        await interaction.deferReply({ ephemeral: true });
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
      }

      if (interaction.commandName === "concierge-status") {
        const stats = await this.dependencies.repository.stats();
        await interaction.reply({
          ephemeral: true,
          content: [
            `Collected: **${stats.articles}**`,
            `Full text: **${stats.extracted}**`,
            `Feedback signals: **${stats.feedback}**`,
            `Delivered: **${stats.deliveries}**`,
            `LLM: **${this.dependencies.llm.enabled ? "enabled" : "disabled"}**`,
          ].join(" · "),
        });
      }
    } catch (error) {
      console.error("Discord command failed", error);
      const message = "The concierge hit a temporary error. Please try again shortly.";
      if (interaction.deferred || interaction.replied) await interaction.editReply(message);
      else await interaction.reply({ content: message, ephemeral: true });
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
        actorId: user.id,
        reaction: definition.reaction,
        interface: "discord",
      });
    } catch (error) {
      console.error("Discord reaction feedback failed", error);
    }
  }
}
