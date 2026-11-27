/*
 * The type check `next build` runs on an app route, copied from Next.js
 * 15.1.0's types plugin (dist/build/webpack/plugins/next-types-plugin/index.js,
 * createTypeGuardFile, the route branch, for the one method POST), against
 * test/types/next-route-entry.ts. Next 13 to 15 read a route's first and
 * second argument from its last call signature, so this fails the type
 * check when the handler's last signature is not the Web one.
 * `NextRequest` stands in for next/server's class, which extends Request.
 * Only `npm run typecheck` reads this file.
 */
import * as entry from './next-route-entry';

interface NextRequest extends Request {
  nextUrl: URL;
}

type TEntry = typeof import('./next-route-entry');

type SegmentParams<T extends object = any> = T extends Record<string, any>
  ? { [K in keyof T]: T[K] extends string ? string | string[] | undefined : never }
  : T;

checkFields<
  Diff<
    {
      POST?: Function;
      config?: {};
      generateStaticParams?: Function;
      dynamic?: 'auto' | 'force-dynamic' | 'error' | 'force-static';
      dynamicParams?: boolean;
      runtime?: 'nodejs' | 'experimental-edge' | 'edge';
      maxDuration?: number;
    },
    TEntry,
    ''
  >
>();

type RouteContext = { params: Promise<SegmentParams> };

if ('POST' in entry) {
  checkFields<
    Diff<
      ParamCheck<Request | NextRequest>,
      {
        __tag__: 'POST';
        __param_position__: 'first';
        __param_type__: FirstArg<MaybeField<TEntry, 'POST'>>;
      },
      'POST'
    >
  >();
  checkFields<
    Diff<
      ParamCheck<RouteContext>,
      {
        __tag__: 'POST';
        __param_position__: 'second';
        __param_type__: SecondArg<MaybeField<TEntry, 'POST'>>;
      },
      'POST'
    >
  >();
  checkFields<
    Diff<
      {
        __tag__: 'POST';
        __return_type__: Response | void | never | Promise<Response | void | never>;
      },
      {
        __tag__: 'POST';
        __return_type__: ReturnType<MaybeField<TEntry, 'POST'>>;
      },
      'POST'
    >
  >();
}

type OmitWithTag<T, K extends keyof any, _M> = Omit<T, K>;
type Diff<Base, T extends Base, Message extends string = ''> = 0 extends 1 & T ? {} : OmitWithTag<T, keyof Base, Message>;
type FirstArg<T extends Function> = T extends (...args: [infer T, any]) => any ? (unknown extends T ? any : T) : never;
type SecondArg<T extends Function> = T extends (...args: [any, infer T]) => any ? (unknown extends T ? any : T) : never;
type MaybeField<T, K extends string> = T extends { [k in K]: infer G } ? (G extends Function ? G : never) : never;
type ParamCheck<T> = {
  __tag__: string;
  __param_position__: string;
  __param_type__: T;
};

function checkFields<_ extends { [k in keyof any]: never }>() {}
