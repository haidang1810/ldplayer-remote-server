// Account maintenance from the server shell (works while the relay is running).
//
//   node src/setup.js admin <username>      create an admin account, or make an existing one an
//                                            active admin and set its password
//   node src/setup.js password <username>   set a new password (logs out that user's browsers)
//   node src/setup.js users                 list accounts
//
// The password is asked for on the terminal, or read from RELAY_PASSWORD (non-interactive).
import readline from 'node:readline';
import { hashPassword, validateCredentials } from './auth.js';
import { DB_PATH, Store } from './db.js';

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? question : '');
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function askPassword(username) {
  let password = process.env.RELAY_PASSWORD;
  if (!password) {
    password = await askHidden(`Mật khẩu cho "${username}": `);
    if ((await askHidden('Nhập lại mật khẩu: ')) !== password) fail('Hai lần nhập không khớp.');
  }
  const error = validateCredentials(username, password);
  if (error) fail(error);
  return hashPassword(password);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [command, username] = process.argv.slice(2);
const store = new Store();

switch (command) {
  case 'admin': {
    if (!username) fail('Dùng: node src/setup.js admin <username>');
    const passwordHash = await askPassword(username);
    const existing = store.userByName(username);
    if (existing) {
      store.setPassword(existing.id, passwordHash);
      store.setUserRole(existing.id, 'admin');
      store.setUserStatus(existing.id, 'active');
      store.deleteUserSessions(existing.id);
      console.log(`Đã cập nhật "${existing.username}" thành admin (${DB_PATH}).`);
    } else {
      store.createUser({ username, passwordHash, role: 'admin', status: 'active' });
      console.log(`Đã tạo admin "${username}" (${DB_PATH}).`);
    }
    break;
  }
  case 'password': {
    const user = username && store.userByName(username);
    if (!user) fail(username ? `Không có tài khoản "${username}".` : 'Dùng: node src/setup.js password <username>');
    store.setPassword(user.id, await askPassword(user.username));
    store.deleteUserSessions(user.id);
    console.log(`Đã đổi mật khẩu "${user.username}".`);
    break;
  }
  case 'users': {
    const users = store.listUsers();
    if (!users.length) console.log('Chưa có tài khoản nào.');
    for (const u of users) {
      console.log(`${String(u.id).padStart(4)}  ${u.username.padEnd(24)} ${u.role.padEnd(6)} ${u.status.padEnd(9)} ${u.machines} máy, ${u.keys} key`);
    }
    break;
  }
  default:
    fail('Lệnh: admin <username> | password <username> | users');
}
