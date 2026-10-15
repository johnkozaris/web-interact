import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const LOCAL_TEST_PAGE_TITLE = "Local Test Page";

const LOCAL_TEST_PAGE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${LOCAL_TEST_PAGE_TITLE}</title>
  </head>
  <body>
    <h1>${LOCAL_TEST_PAGE_TITLE}</h1>
    <p>Served from 127.0.0.1 so tests do not depend on the internet.</p>
  </body>
</html>`;

export interface LocalTestSite {
  /** Page URL with a trailing slash, matching what `page.url()` reports. */
  url: string;
  close: () => Promise<void>;
}

export async function startLocalTestSite(): Promise<LocalTestSite> {
  const server = createServer((request, response) => {
    if (request.url !== "/") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(LOCAL_TEST_PAGE_HTML);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
