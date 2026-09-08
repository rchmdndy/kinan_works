import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from './config.js';
import { openDatabase, Repository } from './repository.js';

const [command, ...args] = process.argv.slice(2);
const config = loadConfig(); const repository = new Repository(openDatabase(config.SQLITE_PATH));
try {
  if (command === 'create-user') {
    const username = args[0]?.trim(); const displayName = args[1]?.trim() || username;
    if (!username || !/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) throw new Error('Usage: admin create-user <username> [display-name]');
    if (repository.getUserByUsername(username)) throw new Error('Username already exists');
    const rl = createInterface({ input, output }); const password = await rl.question('Password: '); rl.close();
    if (password.length < 8) throw new Error('Password must contain at least 8 characters'); const now = Date.now();
    repository.createUser({ id: crypto.randomUUID(), username, displayName, active: true, createdAt: now, updatedAt: now }, await Bun.password.hash(password, 'argon2id'));
    console.log(`Created local user ${username}`);
  } else if (command === 'link-owner') {
    const legacyFlag = args.indexOf('--legacy-uid'); const usernameFlag = args.indexOf('--username'); const legacyUid = legacyFlag >= 0 ? args[legacyFlag + 1] : undefined; const username = usernameFlag >= 0 ? args[usernameFlag + 1] : undefined;
    if (!legacyUid || !username) throw new Error('Usage: admin link-owner --legacy-uid <uid> --username <username>'); const user = repository.getUserByUsername(username); if (!user) throw new Error('Local username not found');
    console.log(`Linked ${repository.linkLegacyOwner(legacyUid, user.id)} device(s) from explicit legacy UID to ${username}`);
  } else throw new Error('Commands: create-user, link-owner');
} finally { repository.close(); }
