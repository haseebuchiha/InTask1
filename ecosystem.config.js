module.exports = {
  apps: [
    {
      name: "ping-monitor",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "start --hostname 127.0.0.1",
      exec_mode: "fork",
      instances: 1,
      kill_timeout: 10_000,
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT ?? 3000,
      },
    },
  ],
}
