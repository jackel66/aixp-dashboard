// pm2 app definition. Start with: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'aixp-dashboard',
      cwd: __dirname + '/backend',
      script: 'src/server.js',
      env: { NODE_ENV: 'production', PORT: 3090 },
      max_memory_restart: '768M',
      out_file: __dirname + '/logs/out.log',
      error_file: __dirname + '/logs/err.log',
      merge_logs: true,
      time: true
    }
  ]
};
