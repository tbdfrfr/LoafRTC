module.exports = {
  apps: [
    {
      name: 'loafrtc-server',
      cwd: './server',
      script: 'server.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      error_file: '../logs/loafrtc-server-error.log',
      out_file: '../logs/loafrtc-server-out.log',
      merge_logs: true,
      time: true,
      kill_timeout: 5000,
    },
  ],
};
