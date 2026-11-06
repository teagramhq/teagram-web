import {installNodeEnv} from './api/nodeEnv';
import {ResizeObserverMock} from './mocks/resizeObserver';
import '@lib/polyfill';

installNodeEnv();

vi.stubGlobal('ResizeObserver', ResizeObserverMock);
