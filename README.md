# Gourmet Sub careers: HR dashboard connected to the live site

## How job listings were stored before
- **The Claude preview dashboard** (included for reference in `original-claude-preview/`) stored listings in **Claude's built-in shared database** (a collection called `jobs`), read and written through Claude's `db` feature. It did **not** use browser localStorage. It only works inside Claude and needs a Claude sign-in, so it cannot be connected to Netlify.
- **Your live site** (careers.gourmetsubnz.com) is a **static HTML page**. It has no dashboard and no database. Roles were meant to be typed into the file, and applications arrive by email.

## How it works now
- **Storage:** Netlify Blobs (a key-value store that is part of your Netlify site). One record per listing. Browser storage is not used.
- **API:** one Netlify Function, `netlify/functions/api.mjs`.
  - Public: `GET /api/jobs` returns open listings only. The careers page loads these on every visit, so changes show up automatically.
  - HR only: create, edit, publish, close, reopen and delete listings, plus the "Generate listing" helper.
- **Dashboard:** `public/admin/index.html`, at careers.gourmetsubnz.com/admin. Same design as before: sign in, job list with Open, Draft and Closed pills, and the New and Edit pop-up with required `*` fields and a generator.
- **Careers page:** `public/index.html`, your existing design, now reading listings from `/api/jobs`.

## Security
- Passwords are stored only as salted scrypt hashes in a Netlify environment variable, never in the code.
- Sign-in sets a signed, HttpOnly, Secure, SameSite=Strict cookie that lasts 8 hours. The cookie is invisible to page scripts.
- Every write needs the session cookie, a same-origin request and a custom header (protects against cross-site requests).
- Five wrong passwords lock that email and device for 15 minutes.
- All input is validated and length-limited on the server. Everything shown in the dashboard and the careers page is escaped.
- Security headers and a strict content policy are set in `netlify.toml`. The admin pages are marked noindex.
- Not included: two-factor sign-in and password reset. For two-factor, put Cloudflare Access or a similar service in front of `/admin`. To change a password, make a new user entry (below) and update `HR_USERS`.

## Setup (about 30 minutes)
You need Node.js 20+ on your computer.

1. **Set your hiring email.** Open `public/index.html`, find `HR_EMAIL` and put in the inbox that receives applications. (Use the same address as on your live site now.)
2. **Create HR users.** In a terminal inside this folder run, once per person:
   `node tools/make-user.mjs hr@gourmetsubnz.com "a long passphrase of 12+ characters"`
   Combine the printed lines into a JSON array, for example `[{...},{...}]`. It also prints a random value you can use as the session secret.
3. **Set environment variables in Netlify** (Site configuration → Environment variables), marking them as secret:
   - `SESSION_SECRET`: a random string of 32+ characters.
   - `HR_USERS`: the JSON array from step 2.
   - Optional `ANTHROPIC_API_KEY`: makes "Generate listing" write with Claude. Without it, a standard template is used.
4. **Deploy this folder to your existing Netlify site.** Drag-and-drop uploads do not run functions, so use the Netlify CLI:
   ```
   npm install
   npx netlify-cli login
   npx netlify-cli link       # choose your existing careers site
   npx netlify-cli deploy --prod
   ```
   (Or connect the folder to a GitHub repository and let Netlify deploy it.)
5. **Test.** Open /admin, sign in, create a listing, publish it, and check it appears at careers.gourmetsubnz.com. Close it and check it disappears. Test on your phone.

## Limits to know about
- Applications are still sent by email, so there is no applications tab. Adding applications storage is a separate piece of work.
- Netlify Blobs is not backed up by Netlify. Keep a note of your listings if they matter.
- Two HR users editing the same listing at the same moment: the last save wins.
- I tested the code and dashboard against a simulated Netlify, not on Netlify itself. Check the first deployment carefully.
