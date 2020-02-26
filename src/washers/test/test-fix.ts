import { Log } from "../../core/log";
import { Fix } from "../../core/washers/fix";

export class TestFix extends Fix {
  static readonly title: string = "test-fix";

  async run(): Promise<void> {
    await Log.info(this);
    if (!this.memory.foo) {
      this.memory.foo = 1;
    } else {
      this.memory.foo++;
    }
    return new Promise((resolve, reject) => {
      setTimeout(async () => {
        resolve();
      }, 10000);
    });
  }
}