// Passenger must not install its automatic hook on the private admin listener.
const passenger = typeof PhusionPassenger !== 'undefined' ? PhusionPassenger : undefined;
if (passenger) passenger.configure({ autoInstall: false });
import('./adapters/passenger/start.js').then(module => module.startManagedNode(passenger)).catch(error => {
  // Do not print private paths, keys, invitations or raw exception objects.
  const codes = ['managed_unix_socket_required', 'server_data_in_use', 'unsafe_server_parent', 'unsafe_server_file', 'unsafe_server_data', 'unsafe_courier_socket', 'invalid_passenger_config', 'passenger_config_required', 'EADDRINUSE'];
  const code = codes.includes(error.message) ? error.message : codes.includes(error.code) ? error.code : 'startup_failed';
  console.error(`Automesh node could not start: ${code}. Check private configuration and hosting lifecycle.`);
  process.exitCode = 1;
});
