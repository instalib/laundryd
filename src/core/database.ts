import { DateTime } from "luxon";
import { Item, LogItem } from "./item";
import { Memory } from "./memory";
import { Rinse } from "./washers/rinse";
import { Wash } from "./washers/wash";
import { Washer } from "./washers/washer";

/**
 * Helper class for database functions.
 */
export abstract class Database {
  /**
   * Set up the database connection.
   * @param connection a connection string
   */
  abstract async init(connection: string): Promise<void>;

  /**
   * Modify a saved document so that it matches the definition of Item.
   * @param document the raw document from the database
   */
  abstract hydrateItem(document: any): Item;

  /**
   * Prepare an item to be saved to the database.
   * @param item the item to save
   */
  abstract dehydrateItem(item: Item): any;

  /**
   * Return the memory object for a washer, or an empty object if there isn't one.
   * @param washer the washer
   */
  abstract async loadMemory(washer: Washer): Promise<Memory>;

  /**
   * Save the memory object for a washer.
   * @param washer the washer
   * @param memory the memory object
   */
  abstract async saveMemory(washer: Washer): Promise<void>;

  /**
   * Get items from a washer newer than a given date.
   * @param washer the washer
   * @param since return items newer than this date
   */
  abstract async loadItems(
    washer: Washer,
    since: DateTime,
    filter: any
  ): Promise<Item[]>;

  /**
   * Save new items generated by a washer
   * @param washer the washer
   * @param saveItems the items generated by the washer
   */
  abstract async saveItems(washer: Wash | Rinse, items: Item[]): Promise<void>;

  /**
   * Receive a callback whenever a washer generates a new item.
   * @param washer the washer to subscribe to
   * @param callback a callback to receive new items on
   * @param filter receive only items that match this filter
   */
  abstract subscribeToWasher(
    washer: Wash | Rinse,
    callback: (item: Item) => void,
    filter: any
  ): void;

  /**
   * Receive a callback whenever a new log item is created.
   * @param callback a callback to receive new log messages on
   * @param filter receive only messages that match this filter
   */
  abstract subscribeToLog(callback: (item: Item) => void, filter: any): void;

  /**
   * Receive a callback whenever an item is added to a collection.
   * @param collection the collection to subscribe to
   * @param callback a callback to receive new items on
   * @param filter receive only messages that match this filter
   */
  abstract subscribeToCollection(
    collection: string,
    callback: (item: Item) => void,
    filter: any
  ): void;

  /**
   * Write a message to the log file.
   * @param log the log message
   */
  abstract async writeLog(log: LogItem): Promise<void>;

  /**
   * Return an existing Item by URL
   * @param washer the washer making the request
   * @param url the URL of the item
   */
  abstract async existing(
    washer: Washer,
    url: string
  ): Promise<Item | undefined>;
}
