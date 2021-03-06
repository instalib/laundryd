import { OutputFlags } from "@oclif/parser/lib/parse";
import {
  AccountRepositoryCurrentUserResponseUser,
  IgApiClient,
} from "instagram-private-api";
import { Dry, Item, Log, Settings, WasherInfo } from "../../core";
import { Instagram } from "./instagram";

export class Save extends Dry {
  static readonly info = new WasherInfo({
    title: "Instagram save",
    description: "save Instagram posts",
    filter: Instagram.filter,
  });

  static settings = {
    ...Dry.settings,
    ...Instagram.authSettings,
    state: Settings.boolean({
      default: true,
      description: "false to unsave the post",
    }),
  };

  config!: OutputFlags<typeof Save.settings>;

  client!: IgApiClient;
  user!: AccountRepositoryCurrentUserResponseUser;

  async init(): Promise<void> {
    this.client = await Instagram.auth(this, this.config);
    this.user = await this.client.account.currentUser();
  }

  async run(items: Item[]): Promise<void> {
    for (const item of items) {
      const mediaId = Instagram.urlToId(item.url);

      if (!mediaId) {
        await Log.warn(this, { msg: `couldn't save ${item.url}` });
        continue;
      }

      await Log.debug(this, {
        msg: this.config.state ? "save" : "unsave",
        url: item.url,
      });
      if (this.config.state) {
        await this.client.media.save(mediaId);
      } else {
        await this.client.media.unsave(mediaId);
      }
    }
  }
}
