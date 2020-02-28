import { flags } from "@oclif/command";
import { OutputFlags } from "@oclif/parser/lib/parse";
import axios from "axios";
import { DateTime, Duration } from "luxon";
import { stringify } from "querystring";
import { Database } from "../../storage/database";
import { Downloader } from "../../storage/downloader";
import { FileStore } from "../../storage/fileStore";
import { Log } from "../log";
import { Memory } from "../memory";
import { Settings } from "../settings";
import { Shared, Sources } from "./shared";
import { WasherInfo } from "./washerInfo";

export class Washer {
  static readonly info = new WasherInfo({
    title: "washer base class",
    description: "washer base class",
    abstract: true
  });

  memory!: Memory;
  running = false;

  static settings = {
    id: flags.string({
      required: true,
      parse: (input: string) => {
        if (
          input.startsWith("system.") ||
          !input.match(/^[\\\/A-Za-z0-9_-]+$/)
        ) {
          throw new Error(`invalid washer id "${input}"`);
        }
        return input;
      },
      description: "a unique identifier for this washer"
    }),

    enabled: Settings.boolean({
      default: true,
      description: "whether to run this washer at all"
    }),

    memory: Settings.boolean({
      default: true,
      description: "whether to save memory after each run"
    }),

    files: Settings.files(),
    fileUrl: Settings.filesUrl(),
    retain: Settings.retain(),
    downloadPool: Settings.downloadPool()
  };

  config!: OutputFlags<typeof Washer.settings>;

  fileStore!: FileStore;
  downloader: Downloader = new Downloader(this);

  // The HTTP client that commands should use.
  protected http = axios.create();

  paused = false;

  constructor(config: OutputFlags<typeof Washer.settings>) {
    if (this.constructor === Washer) {
      throw new Error("don't instantiate Washer directly, use Wash/Rinse/Dry");
    }

    this.config = config;
  }

  async init(sources?: Sources): Promise<void> {
    this.memory = await Database.loadMemory(this);
    await Shared.initFileStore(this);

    // Log all http requests.
    this.http.interceptors.request.use(async config => {
      const params = config.params ? `?${stringify(config.params)}` : "";
      const url = `${config.baseURL || ""}${config.url}${params}`;
      await Log.info(this, { event: "http", url });
      return config;
    });

    // Handle all http errors.
    this.http.interceptors.response.use(
      response => response,
      async error => {
        const params = error.config.params
          ? `?${stringify(error.config.params)}`
          : "";
        const url = `${error.config.baseURL || ""}${error.config.url}${params}`;
        await Log.error(this, { event: "http", url, error });
      }
    );
  }

  get info(): WasherInfo {
    return Object.getPrototypeOf(this).constructor.info;
  }

  /**
   * Return a date before which things created by this washer should be deleted.
   * @param washer the washer whose date to return
   */
  retainDate(): DateTime | undefined {
    if (this.config.retain === 0) {
      // Keep forever
      return;
    }

    // Delete immediately
    let retainDate = DateTime.utc().plus(Duration.fromObject({ years: 1000 }));

    if (this.config.retain > 0) {
      // Delete things more than retain days old
      retainDate = DateTime.utc().minus(
        Duration.fromObject({ days: this.config.retain })
      );
    }

    return retainDate;
  }
}
