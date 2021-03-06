import { flags } from "@oclif/command";
import { OutputFlags } from "@oclif/parser/lib/parse";
import { AxiosRequestConfig, AxiosResponse } from "axios";
import delay from "delay";
import { DateTime } from "luxon";
import path from "path";
import querystring from "querystring";
import {
  Config,
  Download,
  DownloadResult,
  Item,
  Log,
  Shared,
  Wash,
  Washer,
} from "../../core";
import { Like } from "./like";
import { Repost } from "./repost";

export class Mixcloud {
  static api = "https://api.mixcloud.com";

  static icon =
    "https://www.mixcloud.com/media/images/www/global/favicon-64.png";

  static urlPattern = /^http(s)?:\/\/(www.)?mixcloud.com/i;

  static filter = {
    url: { $regex: "^http(s)?:\\/\\/(www.)?mixcloud.com", $options: "i" },
  };

  static authSettings = {
    clientId: flags.string({
      required: true,
      description:
        "the client ID for the Mixcloud application, which can be created at https://www.mixcloud.com/developers/create/",
    }),

    clientSecret: flags.string({
      required: true,
      description: "the client secret for the Mixcloud application",
    }),

    code: flags.string({
      hidden: true,
      description: "the oauth code used to get an access token",
    }),

    token: flags.string({
      description: "the access token for the Mixcloud API",
    }),
  };

  /**
   * Authorize against the Mixcloud API and return information about the user
   * @param washer the washer that is making the request
   * @param auth auth settings
   */
  static async auth(
    washer: Washer,
    auth: OutputFlags<typeof Mixcloud.authSettings>
  ): Promise<any> {
    const [user, repo] = Config.config.pjson.repository.split("/");
    const redirectUrl = "https://${user}.github.io/${repo}/auth/mixcloud.html";
    const params = querystring.stringify({
      client_id: auth.clientId,
      redirect_uri: redirectUrl,
    });
    const authUrl = `https://www.mixcloud.com/oauth/authorize?${params}`;

    if (auth.code) {
      const res = await Mixcloud.callAPI(washer, {
        url: "https://www.mixcloud.com/oauth/access_token",
        params: {
          client_id: auth.clientId,
          redirect_uri: redirectUrl,
          client_secret: auth.clientSecret,
          code: auth.code,
        },
      });
      const t = res.data.access_token;
      if (t) {
        await Log.error(washer, {
          msg: `Token acquired. Use --token=${t} or set MIXCLOUD_TOKEN for this washer.`,
        });
      }
    }

    if (!auth.token) {
      await Log.error(washer, {
        msg: `You don't have an access token. Go to this URL in a browser:\n${authUrl} \n\nThen run the washer again with --code=[code]`,
      });
    }

    // Get the user's profile info.
    if (auth.token) {
      const me = await Mixcloud.callAPI(washer, {
        url: `${Mixcloud.api}/me/`,
        params: { access_token: auth.token, metadata: 1 },
      });
      return me;
    }
  }

  /**
   * Queue a request to the Mixcloud API, handling rate limits as needed.
   * @param washer the washer making the request
   * @param config the request configuration
   */
  static async callAPI(
    washer: Washer,
    config: AxiosRequestConfig
  ): Promise<AxiosResponse<any>> {
    const retry = async (error: any): Promise<void> => {
      const limited = error.response.data?.error?.type === "RateLimitException";
      let time = parseInt(error.response.headers["retry-after"]);

      if (!limited || isNaN(time)) {
        // This isn't a rate limit error, so throw it
        throw error;
      }

      time = (time + 5) * 1000;
      await Log.debug(washer, { msg: `rate limit delay ${time}ms` });
      await delay(time);
    };

    // @ts-ignore: token doesn't exist on all washers
    const queueName = washer.config.token;

    return await Shared.queueHttp(washer, queueName, config, retry);
  }

  /**
   * Get shows from a specific user.
   * @param washer the washer that is making the request
   * @param user the username to get shows from
   * @param since how far back to request shows for
   */
  static async getUserShows(washer: Wash, user: string): Promise<Item[]> {
    // Set up the first request.
    const req = {
      url: `${Mixcloud.api}/${user}/cloudcasts/`,
      params: {
        limit: 50,
        since: Math.floor(washer.memory.lastRun.toSeconds()),
      },
    };

    // Get a paged list of shows.
    let data: any[] = [];
    while (true) {
      const res = await Mixcloud.callAPI(washer, req);
      data = data.concat(res.data.data);

      if (!res.data.data.length || !res.data.paging || !res.data.paging.next) {
        break;
      }

      req.url = res.data.paging.next;
    }

    for (const d of data) {
      await Mixcloud.getShowDescription(washer, d);
    }

    return data.map((d) => Mixcloud.parseData(washer, d));
  }

  static htmlTemplate = Shared.loadTemplate(
    path.join(__dirname, "template.hbs")
  );

  /**
   * Add text/html attributes to a show containing its description.
   * @param washer the washer that is making the request
   * @param show the show to add a description to
   */
  static async getShowDescription(washer: Wash, show: any): Promise<void> {
    const res = await Mixcloud.callAPI(washer, {
      url: `${Mixcloud.api}${show.key}`,
    });

    show.text = res.data.description;
    show.html = Mixcloud.htmlTemplate(res.data);
  }

  /**
   * Convert a raw API object into an Item.
   * @param data the show object from the API
   */
  static parseData(washer: Wash, data: any): Item {
    data = data.meta || data;
    const embedFeed = encodeURIComponent(data.key);

    const item = Shared.createItem(
      data.url,
      DateTime.fromJSDate(new Date(Date.parse(data.created_time))).toUTC(),
      washer
    );

    item.title = data.name;
    item.text = data.text;
    item.html = data.html;
    item.embed = `<iframe width="100%" height="120" src="https://www.mixcloud.com/widget/iframe/?hide_cover=1&light=1&feed=${embedFeed}" frameborder="0"></iframe>`;
    item.meta = data;

    if (!washer.config.download) {
      item.html = `${item.html}${item.embed}`;
    }

    if (data.tags) {
      item.tags = data.tags
        .map((t: any): string => {
          if (typeof t === "object" && t.name !== undefined) {
            t = t.name;
          }
          return t ? `${t}`.toLowerCase() : "";
        })
        .filter((t: string) => t);
    }

    if (data.user) {
      item.author = data.user.name;
      item.source = {
        title: data.user.name,
        image: data.user.pictures.extra_large,
        url: `https://www.mixcloud.com/${data.user.username}/uploads/`,
      };
    }

    item.downloads = [
      Download.audio(item, item.url, (result: DownloadResult) => {
        if (result.image) {
          item.image = `${result.url}/${result.image}`;
          if (item.meta) {
            item.meta.pictures.extra_large = item.image;
          }
        }

        if (result.media) {
          item.media = {
            file: `${result.url}/${result.media}`,
            size: result.size as number,
            type: result.type as string,
            duration: data.audio_length as number,
          };
        }
      }),
    ];

    return item;
  }

  // https://www.mixcloud.com/developers/#following-favoriting
  static async showAction(washer: Like | Repost, item: Item): Promise<void> {
    const action = washer instanceof Like ? "favorite" : "repost";

    let url = item.url;

    // Use the API endpoint
    url = url.replace(Mixcloud.urlPattern, Mixcloud.api);

    // Add trailing slash
    if (!url.match(/\/$/)) {
      url += "/";
    }

    // Add action
    url += `${action}/`;

    const req: AxiosRequestConfig = {
      url,
      method: washer.config.state ? "post" : "delete",
      params: { access_token: washer.config.token },
    };

    await Mixcloud.callAPI(washer, req);
  }
}
