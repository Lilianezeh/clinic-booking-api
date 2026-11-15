const { migrate } = require('./db');
const app = require('./app');

const port = Number(process.env.PORT || 3000);

migrate()
  .then(() => app.listen(port, () => console.log(`clinic-booking listening on :${port}`)))
  .catch((err) => {
    console.error('failed to start', err);
    process.exit(1);
  });
