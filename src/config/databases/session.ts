import {Database} from '.';
import {scopeServerDatabaseName} from '@config/serverContext';

const DATABASE_SESSION: Database<'session'> = {
  name: scopeServerDatabaseName('telegram'),
  version: 1,
  stores: [{
    name: 'session'
  }]
};

export default DATABASE_SESSION;
