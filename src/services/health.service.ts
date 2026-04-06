/**
 * Service handling health checks
 */
export const getHealthStatus = () => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'Farm-Doctor-Bot',
  };
};
