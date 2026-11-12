import app from './app.js';
import { getFinePerDay } from './config/fine.js';

getFinePerDay();
const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
