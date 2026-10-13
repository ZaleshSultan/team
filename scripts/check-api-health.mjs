// Fixed loopback URL; no environment values, request URLs or errors are printed.
try {
  const response = await fetch('http://127.0.0.1:3000/ready', { signal: AbortSignal.timeout(8_000), redirect: 'error' });
  process.exitCode = response.ok && (await response.json()).status === 'ok' ? 0 : 1;
} catch { process.exitCode = 1; }
