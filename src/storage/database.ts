import { Collection, Db, MongoClient } from "mongodb";
import { Item, LoadedItem } from "../core/item";
import { Rinse } from "../core/washers/rinse";
import { Wash } from "../core/washers/wash";
import { Washer, WasherInstance } from "../core/washers/washer";

/**
 * Helper class for database functions.
 */
export class Database {
  private db!: Db;
  private memory!: Collection<any>;

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

    this.memory = this.db.collection("memory");
    await this.memory.createIndex("washerId", { unique: true });
  }

  /**
   * Return the memory object for a washer, or an empty object if there isn't one.
   * @param washer the washer
   */
  async loadMemory(washer: WasherInstance): Promise<void> {
    const memory = await this.memory.findOne({ washerId: washer.id });
    washer.memory = memory || {};
  }

  /**
   * Save the memory object for a washer.
   * @param washer the washer
   * @param memory the memory object
   */
  async saveMemory(washer: WasherInstance): Promise<void> {
    await this.memory.replaceOne(
      { washerId: washer.id },
      { $set: washer.memory },
      { upsert: true }
    );
  }

  /**
   * Get items from a washer newer than a given date.
   * @param washer the washer
   * @param since return items newer than this date
   */
  async loadItems(washer: WasherInstance, since: Date): Promise<LoadedItem[]> {
    if (!washer) {
      return [];
    }

    const items: LoadedItem[] = await this.db
      .collection(washer.id)
      .find(
        {
          date: { $gt: since }
        },
        { sort: { date: -1 } }
      )
      .toArray();

    items.forEach(i => {
      i.washerId = washer.id;
      i.washerTitle = washer.getInfo().title;
    });

    return items;
  }

  /**
   * Save new items generated by a washer
   * @param washer the washer
   * @param items the items generated by the washer
   */
  async saveItems(washer: Washer, items: Item[]): Promise<void> {
    if (!washer || !items.length) {
      return;
    }

    const collection = this.db.collection(washer.id);
    await collection.createIndex("date");
    await collection.insertMany(items);

    if (washer instanceof Wash || washer instanceof Rinse) {
      if (washer.retainDate) {
        await collection.deleteMany({ date: { $lt: washer.retainDate } });
      }
    }
  }

  /**
   * Receive a callback whenever a washer generates a new item.
   * @param washer the washer to subscribe to
   * @param callback a callback to receive new items on
   */
  subscribe(washer: Washer, callback: (item: LoadedItem) => void): void {
    const pipeline = [{ $match: { operationType: "insert" } }];
    const changeStream = this.db.collection(washer.id).watch(pipeline);

    changeStream.on("change", change => {
      const item: LoadedItem = change.fullDocument;
      item.washerId = washer.id;
      item.washerTitle = washer.getInfo().title;
      callback(item);
    });
  }
}
