import { useTestEnvironment } from './environment';

// ConfigModule.forRoot validates the environment when AppModule is imported,
// so the test environment must exist before any test file loads.
useTestEnvironment();
