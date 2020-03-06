import clone from "clone";
import franc from "franc";
import { DateTime } from "luxon";
import {
  Collection,
  Db,
  FilterQuery,
  FindOneOptions,
  MongoClient
} from "mongodb";
import { Database } from "../core/database";
import { Item, LoadedItem, LogItem, MongoLanguage } from "../core/item";
import { Log } from "../core/log";
import { Memory } from "../core/memory";
import { Rinse } from "../core/washers/rinse";
import { Wash } from "../core/washers/wash";
import { Washer } from "../core/washers/washer";

/**
 * Helper class for database functions.
 */
export class MongoDB extends Database {
  private db!: Db;
  private memory!: Collection<any>;
  private log!: Collection<any>;

  /**
   * Set up the database connection.
   * @param connection a mongodb:// connection string
   */
  async init(connection: string): Promise<void> {
    const client = await new MongoClient(connection, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    }).connect();
    this.db = client.db();

    // A collection to save state for each washer
    const memory = this.db.collection("memory");
    await memory.createIndexes([
      { name: "washerId", key: { washerId: 1 }, unique: true }
    ]);
    this.memory = memory;

    // A collection to save logs
    this.log = await this.db.createCollection(Log.collection, {
      capped: true,
      size: 1048576 * 10 // 10MB
    });
    await this.log.createIndexes([
      { name: "created", key: { created: -1 } },
      { name: "saved", key: { saved: -1 } }
    ]);
  }

  /**
   * Modify a saved document so that it matches the definition of LoadedItem.
   * @param document the raw document from the database
   * @param washer the washer that created the item
   */
  hydrateItem(document: any, name?: string, id?: string): LoadedItem {
    delete document._id;
    if (name) {
      document.washerName = name;
    }
    if (id) {
      document.washerId = id;
    }
    document.saved = DateTime.fromJSDate(document.saved).toUTC();
    document.created = DateTime.fromJSDate(document.created).toUTC();
    return document;
  }

  hydrateWasherItem(document: any, washer: Washer): LoadedItem {
    return this.hydrateItem(document, washer.info.name, washer.config.id);
  }

  /**
   * Prepare an item to be saved to the database.
   * @param item the item being saved
   */
  dehydrateItem(item: Item): any {
    const document: any = clone(item);
    delete document.downloads;
    document.saved = DateTime.utc();

    if (!document.language) {
      document.franc = franc(`${item.title} ${item.text} ${item.tags}`);
      const francLangs = Object.values(MongoLanguage);
      const mongoLangs = Object.keys(MongoLanguage);
      const mongoLang = mongoLangs[francLangs.indexOf(document.franc)];
      if (mongoLang) {
        document.language = mongoLang;
      }
    }

    return document;
  }

  /**
   * Return the memory object for a washer, or an empty object if there isn't one.
   * @param washer the washer
   */
  async loadMemory(washer: Washer): Promise<Memory> {
    let memory = await this.memory.findOne({
      washerId: washer.config.id
    });
    memory = memory || {};

    if (memory.lastRun) {
      memory.lastRun = DateTime.fromJSDate(memory.lastRun).toUTC();
    } else {
      memory.lastRun = DateTime.fromSeconds(0);
    }

    memory.config = memory.config || washer.config;

    return memory;
  }

  /**
   * Save the memory object for a washer.
   * @param washer the washer
   * @param memory the memory object
   */
  async saveMemory(washer: Washer): Promise<void> {
    if (!washer.info.memory && !washer.config.schedule) {
      return;
    }

    washer.memory.lastRun = DateTime.utc();
    washer.memory.lastDuration = washer.memory.lastRun.diff(
      washer.startTime
    ).milliseconds;
    washer.memory.config = washer.config;

    await this.memory.replaceOne(
      { washerId: washer.config.id },
      { $set: washer.memory },
      { upsert: true }
    );
  }

  /**
   * Get items from a washer newer than a given date.
   * @param washer the washer
   * @param since return items newer than this date
   */
  async loadItems(
    washer: Washer,
    since: DateTime,
    filter: FilterQuery<any> = {}
  ): Promise<LoadedItem[]> {
    if (!washer) {
      return [];
    }

    filter = Object.assign(filter, { saved: { $gt: since } });
    const options: FindOneOptions = { sort: { saved: -1 } };

    const items: any[] = await this.db
      .collection(washer.config.id)
      .find(filter, options)
      .toArray();

    const loadedItems = items.map(i => this.hydrateWasherItem(i, washer));

    return loadedItems;
  }

  /**
   * Save new items generated by a washer
   * @param washer the washer
   * @param saveItems the items generated by the washer
   */
  async saveItems(washer: Wash | Rinse, items: Item[]): Promise<void> {
    if (!washer || !items || !items.length) {
      return;
    }

    // Set up the collection
    const collection = this.db.collection(washer.config.id);

    await collection.createIndexes([
      { name: "created", key: { created: -1 } },
      { name: "saved", key: { saved: -1 } },
      { name: "url", key: { url: 1 }, unique: true },
      {
        name: "text",
        key: { title: "text", tags: "text", author: "text", text: "text" },
        weights: { title: 10, tags: 10, author: 10, text: 5 }
      }
    ]);

    // Prepare the items for saving
    const saveItems: any[] = items.map(i => this.dehydrateItem(i));

    // Save the items
    await Promise.all(
      saveItems.map(i =>
        collection.replaceOne({ url: i.url }, { $set: i }, { upsert: true })
      )
    );

    // Delete old items
    const retainDate = washer.retainDate();
    if (!retainDate) {
      return;
    }

    await collection.deleteMany({ created: { $lt: retainDate } });
  }

  /**
   * Receive a callback whenever a washer generates a new item.
   * @param washer the washer to subscribe to
   * @param callback a callback to receive new items on
   * @param filter receive only items that match this filter
   */
  subscribeToWasher(
    washer: Wash | Rinse,
    callback: (item: LoadedItem) => void,
    filter: FilterQuery<any> = {}
  ): void {
    this.subscribeToCollection(
      washer.config.id,
      (change: any) => {
        const item: LoadedItem = this.hydrateWasherItem(
          change.fullDocument,
          washer
        );

        callback(item);
      },
      filter
    );
  }

  /**
   * Receive a callback whenever a new log item is created.
   * @param callback a callback to receive new log messages on
   * @param filter receive only messages that match this filter
   */
  subscribeToLog(
    callback: (item: LoadedItem) => void,
    filter: FilterQuery<any> = {}
  ): void {
    this.subscribeToCollection(
      Log.collection,
      (change: any) => {
        const item: LoadedItem = this.hydrateItem(change.fullDocument);

        callback(item);
      },
      filter
    );
  }

  subscribeToCollection(
    collection: string,
    callback: (item: LoadedItem) => void,
    filter: FilterQuery<any> = {}
  ): void {
    const match: any = {};
    Object.keys(filter).forEach(k => (match[`fullDocument.${k}`] = filter[k]));
    match.operationType = "insert";

    const pipeline = [{ $match: match }];

    const changeStream = this.db.collection(collection).watch(pipeline);

    changeStream.on("change", change => {
      callback(change);
    });
  }

  /**
   * Write a message to the log file.
   * @param log the log message
   */
  async writeLog(log: LogItem): Promise<void> {
    await this.log.insertOne(log);
  }
}