function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Creates a tiny prefixed logger.
 * @param {string} prefix
 */
export function createLogger(prefix) {
  const write = (level, args) => {
    const line = `[${timestamp()}] [${prefix}] ${level}`;
    if (level === 'ERROR') console.error(line, ...args);
    else if (level === 'WARN') console.warn(line, ...args);
    else console.log(line, ...args);
  };

  return {
    info: (...args) => write('INFO ', args),
    warn: (...args) => write('WARN ', args),
    error: (...args) => write('ERROR', args),
    child: (childPrefix) => createLogger(`${prefix}:${childPrefix}`),
  };
}
