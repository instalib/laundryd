import { OutputFlags } from "@oclif/parser/lib/parse";
import { DateTime } from "luxon";
import { Files } from "../files";
import { Item } from "../item";
import { Log } from "../log";
import { Settings } from "../settings";
import { Shared, Sources } from "./shared";
import { Washer } from "./washer";
import { WasherInfo } from "./washerInfo";

export class Dry extends Washer {
  static readonly info = new WasherInfo({
    title: "dry base class",
    description:
      "accept normalized data on a schedule or as it arrives, and take actions on it",
    abstract: true,
  });

  static settings = {
    ...Washer.settings,
    subscribe: Settings.subscribe(),
    filter: Settings.filter(),
  };

  config!: OutputFlags<typeof Dry.settings>;

  async preInit(files: Files, sources: Sources): Promise<void> {
    await super.preInit(files, sources);

    Shared.validateSubscriptions(this, sources);

    await this.init();

    if (this.config.schedule) {
      Shared.startSchedule(this, async () => {
        const input = await Shared.loadSubscriptions(
          this,
          sources,
          this.memory.lastRun
        );
        await this.exec(input);
      });
    } else {
      Shared.initRealtimeSubscriptions(
        this,
        sources,
        async (item) => await this.exec([item])
      );
    }
  }

  async exec(input: Item[]): Promise<void> {
    if (!this.config.enabled || !input || !input.length) {
      return;
    }

    try {
      this.startTime = DateTime.utc();
      this.memory = await this.database.loadMemory(this);
      await Log.info(this, { msg: "start" });
      await this.run(input);
      await this.database.saveMemory(this);
      await this.files.clean();
      await Log.info(this, { msg: "complete" });
    } catch (error) {
      await Log.error(this, { error });
    }
  }

  async run(items: Item[]): Promise<void> {
    return;
  }
}
