# Contributing

This repository is a **published mirror**. FeedBay develops the server inside its main
(private) repository, next to the API and the dashboard it talks to. Every release is
synced here, together with the npm package and the Claude Desktop bundle.

- **Issues**: open them here. Bug reports with the server version (`feedbay_whoami` shows
  it) and the client you use are the most useful.
- **Pull requests**: welcome. We apply the change upstream, credit you in the changelog,
  and it arrives here with the next release. Your PR is then closed with a link to that
  release.
- **Security issues**: please don't open a public issue. Write to the address on
  https://feedbay.io/contact instead.

## Local setup

```bash
npm install
npm run build
npm test
```

Node 18 or newer.
