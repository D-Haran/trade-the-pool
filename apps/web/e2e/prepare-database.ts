import { prepareE2eDatabase } from './database';

void prepareE2eDatabase().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
