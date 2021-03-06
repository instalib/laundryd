import { flags } from "@oclif/command";
import { OutputFlags } from "@oclif/parser/lib/parse";
import { IgApiClient } from "instagram-private-api";
import { Item, ItemSource, Wash, WasherInfo } from "../../core";
import { IgFeedItem, Instagram } from "./instagram";

export default class Tag extends Wash {
  static readonly info = new WasherInfo({
    title: "Instagram tag",
    description: "load new posts from a tag on Instagram",
  });

  static settings = {
    ...Wash.settings,
    ...Instagram.authSettings,
    tag: flags.string({
      required: true,
      description: "the tag to load posts from",
    }),
  };

  config!: OutputFlags<typeof Tag.settings>;
  protected client!: IgApiClient;
  protected itemSource!: ItemSource;

  async init(): Promise<void> {
    this.client = await Instagram.auth(this, this.config);
    this.itemSource = {
      image: Instagram.icon,
      url: `${Instagram.url}/explore/tags/${this.config.tag}/`,
      title: `Instagram: ${this.config.tag}`,
    };
  }

  async run(): Promise<Item[]> {
    const feed = this.client.feed.tags(this.config.tag, "recent");
    const data = await Instagram.readFeed(this, feed);
    return Promise.all(data.map((d) => this.parseData(d)));
  }

  async parseData(data: IgFeedItem): Promise<Item> {
    const item = await Instagram.parseData(this, data);
    item.source = this.itemSource;
    return item;
  }
}
