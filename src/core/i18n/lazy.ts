import { lazyMessages as en } from './en/lazy.js';
import { installLazy } from './languages.js';
import { lazyMessages as tr } from './tr/lazy.js';

// imported for its effect by every module that prints these ids
installLazy('en', en);
installLazy('tr', tr);
