import { en } from './en/index.js';
import { installEnglish } from './index.js';

// importing index.js keeps it in the shared chunk
installEnglish(en);
