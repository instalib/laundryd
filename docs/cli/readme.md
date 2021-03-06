laundry
=======

data laundering tools

[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/laundry.svg)](https://npmjs.org/package/laundry)
[![Downloads/week](https://img.shields.io/npm/dw/laundry.svg)](https://npmjs.org/package/laundry)
[![License](https://img.shields.io/npm/l/laundry.svg)](https://github.com/endquote/laundryd/blob/master/package.json)

<!-- toc -->
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->
# Usage
<!-- usage -->
```sh-session
$ npm install -g laundry
$ laundry COMMAND
running command...
$ laundry (-v|--version|version)
laundry/0.0.3 darwin-x64 node-v13.11.0
$ laundry --help [COMMAND]
USAGE
  $ laundry COMMAND
...
```
<!-- usagestop -->
# Commands
<!-- commands -->
* [`laundry commands`](#laundry-commands)
* [`laundry help [COMMAND]`](#laundry-help-command)
* [`laundry run`](#laundry-run)

## `laundry commands`

list all the commands

```
USAGE
  $ laundry commands

OPTIONS
  -h, --help  show CLI help
  -j, --json  output in json format
  --hidden    also show hidden commands
```

_See code: [@oclif/plugin-commands](https://github.com/oclif/plugin-commands/blob/v1.2.3/src/commands/commands.ts)_

## `laundry help [COMMAND]`

display help for laundry

```
USAGE
  $ laundry help [COMMAND]

ARGUMENTS
  COMMAND  command to show help for

OPTIONS
  --all  see all commands in CLI
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/v2.2.3/src/commands/help.ts)_

## `laundry run`

```
USAGE
  $ laundry run

OPTIONS
  --config=config      (required) path to a javascript file exporting an array of washer settings

  --database=database  (required) [default: mongodb://localhost:27017/laundry] database connection string
                       (env: LAUNDRY_DB)

  --fileUrl=fileUrl    (required) [default: http://localhost:3000/files] a URL which maps to the file location
                       (env: LAUNDRY_FILES_URL)

  --files=files        (required) [default: ~/.local/share/laundry] where to store downloaded files, either a local path
                       or an s3:// location
                       (env: LAUNDRY_FILES)
```

_See code: [src/commands/run.ts](https://github.com/endquote/laundryd/blob/master/src/commands/run.ts)_
<!-- commandsstop -->
