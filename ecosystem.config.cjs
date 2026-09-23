// pm2 start ecosystem.config.cjs   (first time; afterwards restart ONLY via `npm run safe-restart`)
module.exports = {
  apps: [
    {
      name: 'agent-runner',
      script: 'src/main.js',
      node_args: '--no-deprecation',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
