#!/usr/bin/env node
import('./build_xiaosonglu_song_data.mjs')
  .then(module => module.main(process.argv.slice(2)))
  .catch(error => {
    console.error(`[build-song-data] ${error.stack ?? error}`);
    process.exitCode = 1;
  });
