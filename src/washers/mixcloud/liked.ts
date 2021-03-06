import { OutputFlags } from "@oclif/parser/lib/parse";
import { Item, ItemSource, Wash, WasherInfo } from "../../core";
import { Mixcloud } from "./mixcloud";

export default class Liked extends Wash {
  static readonly info = new WasherInfo({
    title: "Mixcloud likes",
    description: "load shows you've liked on Mixcloud",
  });

  static settings = {
    ...Wash.settings,
    ...Mixcloud.authSettings,
  };

  config!: OutputFlags<typeof Liked.settings>;
  protected me!: any;
  protected itemSource!: ItemSource;

  async init(): Promise<void> {
    this.me = await Mixcloud.auth(this, this.config);
    this.itemSource = {
      image: this.me.data.pictures.extra_large,
      url: `${this.me.data.url}/favorites`,
      title: this.info.title,
    };
  }

  async run(): Promise<Item[]> {
    if (!this.me) {
      return [];
    }

    // Set up the first request
    const req = {
      url: this.me.data.metadata.connections.favorites,
      params: {
        access_token: this.config.token,
        limit: 50,
        since: Math.floor(this.memory.lastRun.toSeconds()),
      },
    };

    // Get a paged list of favorite shows
    let data: any[] = [];
    while (true) {
      const res = await Mixcloud.callAPI(this, req);
      data = data.concat(res.data.data);

      if (!res.data.data.length || !res.data.paging || !res.data.paging.next) {
        break;
      }

      req.url = res.data.paging.next;
    }

    // Shows don't include descriptions until you request them separately.
    for (const d of data) {
      await Mixcloud.getShowDescription(this, d);
    }

    return data.map((d) => this.parseData(d));
  }

  parseData(data: any): Item {
    const item = Mixcloud.parseData(this, data);
    item.source = this.itemSource;
    return item;
  }
}
