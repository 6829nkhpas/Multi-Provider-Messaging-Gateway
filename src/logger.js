export function createLogger({ write = console.log } = {}) {
  return {
    info(event, fields = {}) {
      write(JSON.stringify({ level: 'info', event, at: new Date().toISOString(), ...fields }));
    },
    error(event, fields = {}) {
      write(JSON.stringify({ level: 'error', event, at: new Date().toISOString(), ...fields }));
    }
  };
}
