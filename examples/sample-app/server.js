// Sample app: serves a greeting page. Intentionally missing at first: the
// /greeting route that the Playwright suite describes. The workflow adds it.
const http = require('node:http');

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html');
    return res.end('<h1>Sample</h1><a href="/greeting">Greeting</a>');
  }
  res.statusCode = 404;
  res.end('not found');
});

if (require.main === module) server.listen(process.env.PORT || 3100);
module.exports = server;
