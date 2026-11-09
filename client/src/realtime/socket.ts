import { io, type Socket } from 'socket.io-client';

/** One place to create sockets, so tests can replace it. Same origin: Vite proxies /socket.io. */
export function createSocket(): Socket {
  return io({ path: '/socket.io', transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000 });
}
