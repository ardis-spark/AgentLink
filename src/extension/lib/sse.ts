/** Incremental parser for a `text/event-stream` body. Only `data:` fields are used by the companion. */
export function createSseParser(onData: (data: string) => void): { feed: (chunk: string) => void } {
  let buffer = '';
  return {
    feed(chunk: string): void {
      buffer += chunk.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(line.charAt(5) === ' ' ? 6 : 5))
          .join('\n');
        if (data) onData(data);
        boundary = buffer.indexOf('\n\n');
      }
    },
  };
}
