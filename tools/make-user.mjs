// Usage: node tools/make-user.mjs hr@gourmetsubnz.com "a long passphrase"
// Prints one JSON object. Put one or more of them in the HR_USERS environment variable as a JSON array.
import { randomBytes, scryptSync } from 'node:crypto';
const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 12) {
  console.error('Usage: node tools/make-user.mjs <email> "<password of 12+ characters>"');
  process.exit(1);
}
const salt = randomBytes(16).toString('hex');
const hash = scryptSync(password, salt, 64).toString('hex');
console.log(JSON.stringify({ email: email.trim().toLowerCase(), salt, hash }));
console.error('\nSession secret (use as SESSION_SECRET if you need one):', randomBytes(32).toString('hex'));
