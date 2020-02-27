import clone from "clone";
import { DateTime } from "luxon";
import { Collection, Db, MongoClient } from "mongodb";
import { Item, LoadedItem, LogItem } from "../core/item";
import { Log, LogLevel } from "../core/log";
import { Memory } from "../core/memory";
import { Rinse } from "../core/washers/rinse";
import { Wash } from "../core/washers/wash";
import { Washer } from "../core/washers/washer";

/**
 * Helper class for database functions.
 */
export class Database {
  private static db: Db;
  private static memory: Collection<any>;
  private static log: Collection<any>;

  /**
   * Set up the database connection.
   * @param connection a mongodb:// connection string
   */
  static async init(connection: string): Promise<void> {
    const client = await new MongoClient(connection, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    }).connect();
    Database.db = client.db();

    // A collection to save state for each washer
    const memory = Database.db.collection("memory");
    await memory.createIndex("washerId", { unique: true });
    Database.memory = memory;

    // A collection to save logs
    Database.log = await Database.db.createCollection(Log.collection, {
      capped: true,
      size: 1048576 * 10 // 10MB
    });
    await Database.log.createIndex("date");
  }

  /**
   * Return the memory object for a washer, or an empty object if there isn't one.
   * @param washer the washer
   */
  static async loadMemory(washer: Washer): Promise<Memory> {
    const memory = await Database.memory.findOne({
      washerId: washer.config.id
    });
    return memory || {};
  }

  /**
   * Save the memory object for a washer.
   * @param washer the washer
   * @param memory the memory object
   */
  static async saveMemory(washer: Washer): Promise<void> {
    if (!washer.config.memory) {
      return;
    }
    washer.memory.lastRun = DateTime.utc();
    await Database.memory.replaceOne(
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
  static async loadItems(
    washer: Washer,
    since: DateTime
  ): Promise<LoadedItem[]> {
    if (!washer) {
      return [];
    }

    const items: any[] = await Database.db
      .collection(washer.config.id)
      .find(
        {
          date: { $gt: since }
        },
        { sort: { date: -1 } }
      )
      .toArray();

    items.forEach(i => {
      delete i._id;
      i.washerId = washer.config.id;
      i.washerTitle = washer.getType().title;
      i.date = DateTime.fromJSDate(i.date);
    });

    return items;
  }

  /**
   * Save new items generated by a washer
   * @param washer the washer
   * @param items the items generated by the washer
   */
  static async saveItems(washer: Wash | Rinse, items: Item[]): Promise<void> {
    if (!washer || !items.length) {
      return;
    }

    items = clone(items);
    items.forEach(i => delete i.downloads);

    // Newest items first
    items.sort((a, b) => b.date.toMillis() - a.date.toMillis());
    washer.memory.lastItem = items[0];

    const collection = Database.db.collection(washer.config.id);
    await collection.createIndex("date");
    await collection.createIndex("url", { unique: true });

    await Promise.all(
      items.map(i =>
        collection.replaceOne({ url: i.url }, { $set: i }, { upsert: true })
      )
    );

    const retainDate = washer.retainDate();
    if (!retainDate) {
      return;
    }

    await collection.deleteMany({ date: { $lt: retainDate } });
  }

  /**
   * Receive a callback whenever a washer generates a new item.
   * @param washer the washer to subscribe to
   * @param callback a callback to receive new items on
   */
  static subscribe(
    washer: Wash | Rinse,
    callback: (item: LoadedItem) => void
  ): void {
    const pipeline = [{ $match: { operationType: "insert" } }];
    const changeStream = Database.db
      .collection(washer.config.id)
      .watch(pipeline);

    changeStream.on("change", change => {
      const item: LoadedItem = change.fullDocument;
      item.washerId = washer.config.id;
      item.washerTitle = washer.getType().title;
      callback(item);
    });
  }

  /**
   * Receive a callback whenever a new log message is saved
   * @param level get logs at this level and above
   * @param callback a callback to receive new log messages on
   */
  static subscribeLog(
    level: LogLevel,
    callback: (item: LogItem) => void
  ): void {
    let levels = Object.values(LogLevel);
    levels = levels.slice(levels.indexOf(level));

    const pipeline = [
      {
        $match: {
          $and: [
            { operationType: "insert" },
            { "fullDocument.text": { $in: levels } }
          ]
        }
      }
    ];

    const changeStream = Database.db.collection(Log.collection).watch(pipeline);

    changeStream.on("change", change => {
      const item: LogItem = change.fullDocument;
      callback(item);
    });
  }

  /**
   * Write a message to the log file.
   * @param log the log message
   */
  static async writeLog(log: LogItem): Promise<void> {
    await Database.log.insertOne(log);
  }
}
