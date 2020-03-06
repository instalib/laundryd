import { CronJob } from "cron";
import { DateTime } from "luxon";
import asyncPool from "tiny-async-pool";
import { Download, DownloadResult } from "../download";
import { Item, LoadedItem } from "../item";
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
      start: true
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
  ): Promise<LoadedItem[]> {
    let input: LoadedItem[] = [];
    for (const id of washer.config.subscribe) {
      const items = await washer.database.loadItems(
        sources[id],
        since,
        washer.config.filter
      );
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
    callback: (input: LoadedItem) => Promise<void>
  ): void {
    for (const id of washer.config.subscribe) {
      if (id === Log.collection) {
        washer.database.subscribeToLog(
          (item: LoadedItem) => callback(item),
          washer.config.filter
        );
      } else {
        washer.database.subscribeToWasher(
          sources[id],
          (item: LoadedItem) => callback(item),
          washer.config.filter
        );
      }
    }
  }

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

    await asyncPool(
      washer.config.downloadPool,
      downloads,
      async (download: Download) => {
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
          items = items.filter(i => i !== download.item);
        }
      }
    );

    return items;
  }

  static async checkItems(
    washer: Wash | Rinse,
    items: Item[]
  ): Promise<Item[]> {
    if (!items || !items.length) {
      return items;
    }

    // Don't let bad dates creep in
    const invalid = items.filter(i => !i.created || !i.created.isValid);
    if (invalid.length) {
      await Log.error(washer, {
        msg: "invalid created dates",
        urls: invalid.map(i => i.url)
      });
      items = items.filter(i => !invalid.includes(i));
    }

    // Sort so newest is first
    items.sort((a, b) => b.created.toMillis() - a.created.toMillis());

    return items;
  }
}
