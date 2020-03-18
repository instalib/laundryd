/* eslint-disable @typescript-eslint/camelcase */
import { flags } from "@oclif/command";
import { OutputFlags } from "@oclif/parser/lib/parse";
import {
  IgApiClient,
  LikedFeed,
  LikedFeedResponseItemsItem,
  LocationFeed,
  LocationFeedResponseMedia,
  SavedFeed,
  SavedFeedResponseMedia,
  TagsFeed,
  TagsFeedResponseMedia,
  TimelineFeed,
  TimelineFeedResponseMedia_or_ad,
  UserFeed,
  UserFeedResponseItemsItem
} from "instagram-private-api";
import { DateTime } from "luxon";
import { Item } from "../../core/item";
import { Log } from "../../core/log";
import { Shared } from "../../core/washers/shared";
import { Wash } from "../../core/washers/wash";
import { Washer } from "../../core/washers/washer";

// An alias for the many feed types
export type IgFeed =
  | LikedFeed
  | LocationFeed
  | SavedFeed
  | TagsFeed
  | TimelineFeed
  | UserFeed;

// An alias for the responses from all the feeds
export type IgFeedItem =
  | LikedFeedResponseItemsItem
  | LocationFeedResponseMedia
  | SavedFeedResponseMedia
  | TagsFeedResponseMedia
  | TimelineFeedResponseMedia_or_ad
  | UserFeedResponseItemsItem;

export class Instagram {
  // The biggest favicon
  static icon =
    "https://www.instagram.com/static/images/ico/apple-touch-icon-180x180-precomposed.png/c06fdb2357bd.png";

  // The URL to the site
  static url = "https://www.instagram.com";

  // Settings used by all washers to auth
  static authSettings = {
    username: flags.string({
      required: true,
      description: "Instagram username"
    }),

    password: flags.string({
      required: true,
      description: "Instagram password"
    }),

    code: flags.string({
      description: "the challenge code sent for login"
    })
  };

  // Because feeds aren't chronological, you can't specify how many days back to load.
  static beginSetting = flags.integer({
    default: 0,
    description:
      "the number of past items to load in the first run, 0 to load all"
  });

  private static clients: Record<string, IgApiClient> = {};

  /**
   * Return an authorized Instagram client.
   * @param washer the washer making the request
   * @param auth the authorization settings
   */
  static async auth(
    washer: Washer,
    auth: OutputFlags<typeof Instagram.authSettings>
  ): Promise<IgApiClient> {
    if (Instagram.clients[auth.username]) {
      return Instagram.clients[auth.username];
    }
    const client = new IgApiClient();
    client.state.generateDevice(auth.username);
    try {
      await client.account.login(auth.username, auth.password);
      process.nextTick(async () => await client.simulate.postLoginFlow());
    } catch (IgCheckpointError) {
      await client.challenge.auto(true);
      if (!auth.code) {
        await Log.error(washer, {
          msg:
            "an auth code should have been emailed to you, add that to the washer config"
        });
      } else {
        await client.challenge.sendSecurityCode(auth.code);
      }
    }
    await client.simulate.postLoginFlow();
    Instagram.clients[auth.username] = client;
    return client;
  }

  /**
   * Query an Instagram feed, returning post objects up until previously seen posts.
   * @param washer the washer making the request
   * @param feed the feed containing the posts
   */
  static async readFeed(washer: Wash, feed: IgFeed): Promise<IgFeedItem[]> {
    const data: IgFeedItem[] = [];

    while (true) {
      const posts = await feed.items();
      let done = false;

      for (const post of posts) {
        // Skip ads
        const timelinePost = post as TimelineFeedResponseMedia_or_ad;
        if (timelinePost.ad_id) {
          continue;
        }

        // Limit the number of items loaded on the first run
        if (
          washer.config.begin &&
          !washer.memory.lastId &&
          data.length >= washer.config.begin
        ) {
          done = true;
          break;
        }

        // Skip if we've seen this post before
        if (post.id === washer.memory.lastId) {
          done = true;
          break;
        }

        data.push(post);
      }

      if (done || !feed.isMoreAvailable()) {
        break;
      }
    }

    if (data.length) {
      washer.memory.lastId = data[0].id;
    }

    return data;
  }

  /**
   * Convert an Instagram post object into an Item.
   * @param washer the washer making the request
   * @param data the post to parse
   */
  static async parseData(washer: Washer, data: IgFeedItem): Promise<Item> {
    const item: Item = {
      title: data.user.username,
      url: `https://www.instagram.com/p/${data.code}/`,
      created: DateTime.fromSeconds(data.taken_at),
      meta: data
    };

    if (data.caption) {
      // Add caption to title
      item.title += `: ${data.caption.text.replace(/[\r\n]/g, " ")}`;

      // Parse tags
      item.tags = [];
      const re = /#([\w]+)/g;
      let match;
      while ((match = re.exec(data.caption.text))) {
        item.tags.push(match[0].substr(1));
      }
    }

    // @ts-ignore
    const location = data.location;
    if (location) {
      // Parse location
      item.location = {
        coord: { lat: location.lat, lng: location.lng },
        name: location.name
      };
    }

    // Get the embed code
    const embed = await Shared.queueHttp(washer, {
      url: "https://api.instagram.com/oembed/",
      params: { url: item.url, omitscript: true }
    });
    item.embed = embed.data.html;

    return item;
  }
}