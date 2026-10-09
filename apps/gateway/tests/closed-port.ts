/**
 * A loopback port nothing listens on: connecting is refused, so nothing is ever sent. It is a fixed port below the
 * kernel's ephemeral range (and not on fetch's blocked-port list), never a just-freed ephemeral one: another listener or
 * connection could take such a port before the request arrives and answer it instead of refusing it, which looked
 * like a primary that fails without a failover (no secondary call). Port 2 is privileged, so a test cannot re-bind it:
 * a test that later listens on its closed port must keep a freed ephemeral port instead.
 */
export async function closedPort():Promise<string> {return 'http://127.0.0.1:2';}
