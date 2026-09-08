'use strict';
const readline = require('node:readline/promises');
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const { openDb } = require('../src/db');
const { createModels } = require('../src/models');

const USAGE = `Uso:
  npm run create-admin -- --username admin --password "contraseña"
  npm run create-admin   (modo interactivo)`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--username' || argv[i] === '-u') out.username = argv[++i];
    else if (argv[i] === '--password' || argv[i] === '-p') out.password = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  let username = args.username;
  let password = args.password;

  if (!username || !password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!username) username = (await rl.question('Usuario: ')).trim();
    if (!password) {
      console.log('(la contraseña se mostrará en pantalla al escribirla)');
      password = await rl.question('Contraseña (mínimo 8 caracteres): ');
    }
    rl.close();
  }

  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    console.error('Usuario inválido: 3-64 caracteres (letras, números, punto, guion).');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('La contraseña debe tener al menos 8 caracteres.');
    process.exit(1);
  }

  const db = openDb(config.dbPath);
  const models = createModels(db, config);
  const hash = bcrypt.hashSync(password, 10);

  const existing = models.findUserByUsername(username);
  if (existing) {
    models.updateUserPassword(existing.id, hash);
    console.log(`Contraseña actualizada para «${username}».`);
  } else {
    models.createUser(username, hash);
    console.log(`Usuario «${username}» creado correctamente.`);
  }
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});