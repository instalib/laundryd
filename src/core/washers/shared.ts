import { AxiosRequestConfig, AxiosResponse } from "axios";
import { CronJob } from "cron";
import filenamifyUrl from "filenamify-url";
import fs from "fs-extra";
import { JSDOM } from "jsdom";
import { DateTime } from "luxon";
import PQueue from "p-queue";
import pRetry, { FailedAttemptError } from "p-retry";
import { parse as urlParse } from "url";
import { Handlebars } from "../../core/formatting";
import { Config } from "../config";
import { Download, DownloadResult } from "../download";
import { Item } from "../item";
import { Log } from "../log";
import { Dry } from "./dry";
import { Fix } from "./fix";
import { Rinse } from "./rinse";
import { Wash } from "./wash";
import { Washer } from "./washer";

export type WasherType = typeof Washer;
export type Sources = Record<string, Wash | Rinse>;

/**
 * Elements shared among the washer types.
 */
export class Shared {
  /**
   * Ensure that a washer's subscriptions are valid.
   * @param washer the washer to validate
   * @param sources the available output washers
   */
  static validateSubscriptions(washer: Rinse | Dry, sources: Sources): void {
    if (!washer.config.subscribe || !washer.config.subscribe.length) {
      throw new Error("missing subscribe");
    }

    if (washer.config.subscribe.includes(washer.config.id)) {
      throw new Error("a washer can't subscribe to itself");
    }

    for (const id of washer.config.subscribe) {
      if (id !== Log.collection && !Object.keys(sources).includes(id)) {
        throw new Error(`can't subscribe to ${id}, does not exist`);
      }
    }
  }

  /**
   * Kick off a washer's schedule.
   * @param washer the washer with the schedule
   * @param callback the method to call when the cron ticks
   */
  static startSchedule(
    washer: Wash | Dry | Rinse | Fix,
    callback: () => Promise<void>
  ): void {
    new CronJob({
      cronTime: washer.config.schedule,
      onTick: async (): Promise<void> => {
        if (washer.running || washer.paused) {
          return;
        }
        washer.running = true;
        await callback();
        washer.running = false;
      },
      start: true,
    });
  }

  /**
   * Load recent items from other washers that a washer is subscribed to.
   * @param washer the washer whose subscriptions should be loaded
   * @param sources the available output washers
   * @param since load items newer than this date
   */
  static async loadSubscriptions(
    washer: Rinse | Dry,
    sources: Sources,
    since = DateTime.utc(0)
  ): Promise<Item[]> {
    let input: Item[] = [];
    for (const id of washer.config.subscribe) {
      const filter: any = Shared.buildFilter(washer);
      const items = await washer.database.loadItems(sources[id], since, filter);
      input = input.concat(items);
    }
    return input;
  }

  /**
   * Set up a real-time subscription from one washer to another.
   * @param washer the washer that is subscribing
   * @param sources the available output washers
   * @param callback the method to call with the new items
   */
  static initRealtimeSubscriptions(
    washer: Rinse | Dry,
    sources: Sources,
    callback: (input: Item) => Promise<void>
  ): void {
    const filter = Shared.buildFilter(washer);

    for (const id of washer.config.subscribe) {
      if (id === Log.collection) {
        washer.database.subscribeToLog((item: Item) => callback(item), filter);
      } else {
        washer.database.subscribeToWasher(
          sources[id],
          (item: Item) => callback(item),
          filter
        );
      }
    }
  }

  /**
   * Build a filter from the washer info and configuration.
   * @param washer the washer making the request
   */
  private static buildFilter(washer: Rinse | Dry): any {
    let filter: any = {};
    if (washer.info.filter && washer.config.filter) {
      filter = { $and: [washer.info.filter, washer.config.filter] };
    } else if (washer.info.filter) {
      filter = washer.info.filter;
    } else if (washer.config.filter) {
      filter = washer.config.filter;
    }
    return filter;
  }

  /**
   * Build a minimal item object.
   * @param url the url to the item
   * @param created when the item was created/publushed
   * @param washer the washer making the item
   */
  static createItem(url: string, created: DateTime, washer: Washer): Item {
    if (!url || !created.isValid || !washer) {
      throw new Error("invalid item");
    }
    return {
      washer: { id: washer.config.id, name: washer.info.name },
      created,
      url,
    };
  }

  /**
   * Validate items before saving them.
   * @param washer the washer that created the items
   * @param items the items to check
   */
  static async checkItems(
    washer: Wash | Rinse,
    items: Item[]
  ): Promise<Item[]> {
    if (!items || !items.length) {
      return items;
    }

    // Don't let bad dates creep in
    const invalid = items.filter((i) => !i.created || !i.created.isValid);
    if (invalid.length) {
      await Log.error(washer, {
        msg: "invalid created dates",
        urls: invalid.map((i) => i.url),
      });
      items = items.filter((i) => !invalid.includes(i));
    }

    // Sort so newest is first
    items.sort((a, b) => b.created.toMillis() - a.created.toMillis());

    return items;
  }

  private static downloadQueues: Record<string, PQueue> = {};

  /**
   * Encapsulate the logic of performing file downloads.
   * @param washer the washer that owns the items with the downloads
   * @param items the items with downloads to be processed
   */
  static async downloadItems(
    washer: Wash | Rinse,
    items: Item[]
  ): Promise<Item[]> {
    if (!washer.config.download || !items || !items.length) {
      return items;
    }

    let downloads: Download[] = [];
    for (const i of items) {
      if (i.downloads) {
        downloads = downloads.concat(i.downloads);
      }
    }

    if (!downloads.length) {
      return items;
    }

    const doDownload = async (download: Download): Promise<void> => {
      // Check for an existing download.
      const existing = await washer.files.existing(download);
      if (existing) {
        // Call the complete handler with the existing data.
        download.complete(existing);
        return;
      }

      // Perform the download.
      try {
        await washer.downloader.download(
          download,
          async (result: DownloadResult) => {
            // Process the download, modifying the result.
            result = await washer.files.downloaded(result);
            // Pass the result to the complete handler.
            download.complete(result);
          }
        );
      } catch (error) {
        // Remove items if the downloads fail.
        await Log.warn(washer, { msg: "download-fail", error });
        items = items.filter((i) => i !== download.item);
      }
    };

    const queueName = washer.info.name.split("/")[0];
    if (!this.downloadQueues[queueName]) {
      this.downloadQueues[queueName] = new PQueue({
        concurrency: Config.flags.downloadPool,
      });
    }
    const queue = this.downloadQueues[queueName];
    await queue.addAll(
      downloads.map((d) => (): Promise<void> => doDownload(d))
    );

    return items;
  }

  private static taskQueues: Record<string, PQueue> = {};

  /**
   * Queue an HTTP request from a washer, which will be placed into a queue along
   * with other requests from the same group of washers.
   * @param washer the washer making the request
   * @param queueName queue requests with the same name, or empty to use the washer source
   * @param config the request configuration
   * @param retry run when the request fails
   * @param retries how many times to retry
   */
  static async queueHttp(
    washer: Washer,
    queueName: string | undefined,
    config: AxiosRequestConfig,
    retry?: (error: FailedAttemptError) => void | Promise<void>,
    retries = 1
  ): Promise<AxiosResponse<any>> {
    const http = async (): Promise<AxiosResponse<any>> => {
      await Log.debug(washer, { msg: "http", config });
      return washer.http.request(config);
    };

    let task = http;
    if (retry && retries) {
      task = async (): Promise<AxiosResponse<any>> =>
        await pRetry(http, { onFailedAttempt: retry, retries });
    }

    return await Shared.queueTask(washer, queueName, task);
  }

  /**
   * Queue a task from a washer, which will be placed into a queue along with other
   * tasks from the same group of washers.
   * @param washer the washer creating the task
   * @param queueName queue requests with the same name, or empty to use the washer source
   * @param task the task to run
   */
  static async queueTask(
    washer: Washer,
    queueName: string | undefined,
    task: () => Promise<any>
  ): Promise<any> {
    queueName = queueName || washer.info.name.split("/")[0];

    if (!Shared.taskQueues[queueName]) {
      Shared.taskQueues[queueName] = new PQueue({ concurrency: 1 });
    }

    const queue = Shared.taskQueues[queueName];
    return await queue.add(task);
  }

  /**
   * Convert a URL to a safe filename.
   * @param url the url to convert
   */
  static urlToFilename(url: string): string {
    const parsed = urlParse(url);
    if (parsed.search) {
      url = url.replace(parsed.search, "");
    }

    const options = { maxLength: Number.POSITIVE_INFINITY };
    return filenamifyUrl(url, options).toLowerCase();
  }

  /**
   * Load and compile a handlebars template.
   * @param fileName the file containing the handlebars template
   */
  static loadTemplate(fileName: string): HandlebarsTemplateDelegate<any> {
    return Handlebars.compile(fs.readFileSync(fileName).toString());
  }

  /**
   * Convert an HTML string to text-only using JSDOM.
   * @param html the html to convert
   */
  static htmlToText(html?: string): string | undefined {
    if (!html) {
      return;
    }

    return JSDOM.fragment(html)
      .textContent?.replace(/\s{2,}/gm, " ")
      .trim();
  }
}
