'use strict';

const app = require('./app');
const dbRepository = require('./repositories/dbRepository');
const envConfig = require('./config/env');

async function startServer() {
  try {
    await dbRepository.connectDB();

    // Check that the new pool can provide a usable database connection.
    const connection = await dbRepository.getPool().getConnection();
    try {
      console.log('Connected to Oracle database');
    } finally {
      await connection.close();
    }

    app.listen(envConfig.port, () => {
      console.log(`Server is running on port ${envConfig.port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
