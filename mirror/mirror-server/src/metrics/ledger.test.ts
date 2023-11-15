import {afterAll, describe, expect, test} from '@jest/globals';
import {initializeApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {
  CONNECTION_LIFETIMES,
  CONNECTION_SECONDS,
  Metric,
  Month,
  MonthMetrics,
  ROOM_SECONDS,
  TotalMetrics,
  appMetricsCollection,
  monthMetricsPath,
  teamMetricsCollection,
  totalMetricsPath,
} from 'mirror-schema/src/metrics.js';
import {Ledger} from './ledger.js';

describe('metrics ledger', () => {
  initializeApp({projectId: 'metrics-ledger-test'});
  const firestore = getFirestore();
  const TEAM1 = 'team1';
  const TEAM2 = 'team2';
  const APP1 = 'app1';
  const APP2 = 'app2';
  const APP3 = 'app3';

  afterAll(async () => {
    const batch = firestore.batch();
    for (const coll of [
      teamMetricsCollection(TEAM1),
      teamMetricsCollection(TEAM2),
      appMetricsCollection(APP1),
      appMetricsCollection(APP2),
      appMetricsCollection(APP3),
    ]) {
      const docs = await firestore.collection(coll).listDocuments();
      docs.forEach(doc => batch.delete(doc));
    }
    await batch.commit();
  });

  type Case = {
    name: string;
    teamID: string;
    appID: string;
    hour: Date;
    metrics: [Metric, number][];
    expectUpdated: boolean;
    expectedTeamMonth?: MonthMetrics;
    expectedTeamTotal?: TotalMetrics;
    expectedAppMonth?: MonthMetrics;
    expectedAppTotal?: TotalMetrics;
  };
  const cases: Case[] = [
    {
      name: 'no existing ledger docs',
      teamID: TEAM1,
      appID: APP1,
      hour: new Date(Date.UTC(2023, 0, 31, 23)),
      metrics: [[CONNECTION_SECONDS, 10.23]],
      expectUpdated: true,
      expectedAppMonth: {
        teamID: TEAM1,
        appID: APP1,
        yearMonth: 202300,
        total: {cs: 10.23},
        day: {
          ['31']: {
            total: {cs: 10.23},
            hour: {['23']: {cs: 10.23}},
          },
        },
      },
      expectedTeamMonth: {
        teamID: TEAM1,
        appID: null,
        yearMonth: 202300,
        total: {cs: 10.23},
        day: {
          ['31']: {
            total: {cs: 10.23},
            hour: {['23']: {cs: 10.23}},
          },
        },
      },
      expectedAppTotal: {
        teamID: TEAM1,
        appID: APP1,
        total: {cs: 10.23},
        year: {['2023']: {cs: 10.23}},
      },
      expectedTeamTotal: {
        teamID: TEAM1,
        appID: null,
        total: {cs: 10.23},
        year: {['2023']: {cs: 10.23}},
      },
    },
    {
      name: 'redundant update',
      teamID: TEAM1,
      appID: APP1,
      hour: new Date(Date.UTC(2023, 0, 31, 23)),
      metrics: [[CONNECTION_SECONDS, 10.23]],
      expectUpdated: false,
      expectedAppMonth: {
        teamID: TEAM1,
        appID: APP1,
        yearMonth: 202300,
        total: {cs: 10.23},
        day: {
          ['31']: {
            total: {cs: 10.23},
            hour: {['23']: {cs: 10.23}},
          },
        },
      },
      expectedTeamMonth: {
        teamID: TEAM1,
        appID: null,
        yearMonth: 202300,
        total: {cs: 10.23},
        day: {
          ['31']: {
            total: {cs: 10.23},
            hour: {['23']: {cs: 10.23}},
          },
        },
      },
      expectedAppTotal: {
        teamID: TEAM1,
        appID: APP1,
        total: {cs: 10.23},
        year: {['2023']: {cs: 10.23}},
      },
      expectedTeamTotal: {
        teamID: TEAM1,
        appID: null,
        total: {cs: 10.23},
        year: {['2023']: {cs: 10.23}},
      },
    },
    {
      name: 'update different app, same team',
      teamID: TEAM1,
      appID: APP2,
      hour: new Date(Date.UTC(2023, 0, 31, 23)),
      metrics: [[CONNECTION_SECONDS, 32.46]],
      expectUpdated: true,
      expectedAppMonth: {
        teamID: TEAM1,
        appID: APP2,
        yearMonth: 202300,
        total: {cs: 32.46},
        day: {
          ['31']: {
            total: {cs: 32.46},
            hour: {['23']: {cs: 32.46}},
          },
        },
      },
      expectedTeamMonth: {
        teamID: TEAM1,
        appID: null,
        yearMonth: 202300,
        total: {cs: 42.69},
        day: {
          ['31']: {
            total: {cs: 42.69},
            hour: {['23']: {cs: 42.69}},
          },
        },
      },
      expectedAppTotal: {
        teamID: TEAM1,
        appID: APP2,
        total: {cs: 32.46},
        year: {['2023']: {cs: 32.46}},
      },
      expectedTeamTotal: {
        teamID: TEAM1,
        appID: null,
        total: {cs: 42.69},
        year: {['2023']: {cs: 42.69}},
      },
    },
    {
      name: 'update different hour',
      teamID: TEAM1,
      appID: APP2,
      hour: new Date(Date.UTC(2023, 0, 31, 20)),
      metrics: [[CONNECTION_SECONDS, 24.68]],
      expectUpdated: true,
      expectedAppMonth: {
        teamID: TEAM1,
        appID: APP2,
        yearMonth: 202300,
        total: {cs: 57.14},
        day: {
          ['31']: {
            total: {cs: 57.14},
            hour: {
              ['20']: {cs: 24.68},
              ['23']: {cs: 32.46},
            },
          },
        },
      },
      expectedTeamMonth: {
        teamID: TEAM1,
        appID: null,
        yearMonth: 202300,
        total: {cs: 67.37},
        day: {
          ['31']: {
            total: {cs: 67.37},
            hour: {
              ['20']: {cs: 24.68},
              ['23']: {cs: 42.69},
            },
          },
        },
      },
      expectedAppTotal: {
        teamID: TEAM1,
        appID: APP2,
        total: {cs: 57.14},
        year: {['2023']: {cs: 57.14}},
      },
      expectedTeamTotal: {
        teamID: TEAM1,
        appID: null,
        total: {cs: 67.37},
        year: {['2023']: {cs: 67.37}},
      },
    },
    {
      name: 'update existing value',
      teamID: TEAM1,
      appID: APP2,
      hour: new Date(Date.UTC(2023, 0, 31, 20)),
      metrics: [[CONNECTION_SECONDS, 21.68]],
      expectUpdated: true,
      expectedAppMonth: {
        teamID: TEAM1,
        appID: APP2,
        yearMonth: 202300,
        total: {cs: 54.14},
        day: {
          ['31']: {
            total: {cs: 54.14},
            hour: {
              ['20']: {cs: 21.68},
              ['23']: {cs: 32.46},
            },
          },
        },
      },
      expectedTeamMonth: {
        teamID: TEAM1,
        appID: null,
        yearMonth: 202300,
        total: {cs: 64.37},
        day: {
          ['31']: {
            total: {cs: 64.37},
            hour: {
              ['20']: {cs: 21.68},
              ['23']: {cs: 42.69},
            },
          },
        },
      },
      expectedAppTotal: {
        teamID: TEAM1,
        appID: APP2,
        total: {cs: 54.14},
        year: {['2023']: {cs: 54.14}},
      },
      expectedTeamTotal: {
        teamID: TEAM1,
        appID: null,
        total: {cs: 64.37},
        year: {['2023']: {cs: 64.37}},
      },
    },
    {
      name: 'update different year',
      teamID: TEAM1,
      appID: APP2,
      hour: new Date(Date.UTC(2022, 11, 3, 15)),
      metrics: [[CONNECTION_SECONDS, 10.0]],
      expectUpdated: true,
      expectedAppMonth: {
        teamID: TEAM1,
        appID: APP2,
        yearMonth: 202211,
        total: {cs: 10.0},
        day: {
          ['3']: {
            total: {cs: 10.0},
            hour: {['15']: {cs: 10.0}},
          },
        },
      },
      expectedTeamMonth: {
        teamID: TEAM1,
        appID: null,
        yearMonth: 202211,
        total: {cs: 10.0},
        day: {
          ['3']: {
            total: {cs: 10.0},
            hour: {['15']: {cs: 10.0}},
          },
        },
      },
      expectedAppTotal: {
        teamID: TEAM1,
        appID: APP2,
        total: {cs: 64.14},
        year: {
          ['2022']: {cs: 10.0},
          ['2023']: {cs: 54.14},
        },
      },
      expectedTeamTotal: {
        teamID: TEAM1,
        appID: null,
        total: {cs: 74.37},
        year: {
          ['2022']: {cs: 10.0},
          ['2023']: {cs: 64.37},
        },
      },
    },
    {
      name: 'update different metric',
      teamID: TEAM1,
      appID: APP2,
      hour: new Date(Date.UTC(2022, 11, 3, 15)),
      metrics: [[CONNECTION_LIFETIMES, 11.1]],
      expectUpdated: true,
      expectedAppMonth: {
        teamID: TEAM1,
        appID: APP2,
        yearMonth: 202211,
        total: {
          cs: 10.0,
          cl: 11.1,
        },
        day: {
          ['3']: {
            total: {
              cs: 10.0,
              cl: 11.1,
            },
            hour: {
              ['15']: {
                cs: 10.0,
                cl: 11.1,
              },
            },
          },
        },
      },
      expectedTeamMonth: {
        teamID: TEAM1,
        appID: null,
        yearMonth: 202211,
        total: {
          cs: 10.0,
          cl: 11.1,
        },
        day: {
          ['3']: {
            total: {
              cs: 10.0,
              cl: 11.1,
            },
            hour: {
              ['15']: {
                cs: 10.0,
                cl: 11.1,
              },
            },
          },
        },
      },
      expectedAppTotal: {
        teamID: TEAM1,
        appID: APP2,
        total: {
          cs: 64.14,
          cl: 11.1,
        },
        year: {
          ['2022']: {
            cs: 10.0,
            cl: 11.1,
          },
          ['2023']: {cs: 54.14},
        },
      },
      expectedTeamTotal: {
        teamID: TEAM1,
        appID: null,
        total: {
          cs: 74.37,
          cl: 11.1,
        },
        year: {
          ['2022']: {
            cs: 10.0,
            cl: 11.1,
          },
          ['2023']: {cs: 64.37},
        },
      },
    },
    {
      name: 'update app in new team',
      teamID: TEAM2,
      appID: APP1,
      hour: new Date(Date.UTC(2023, 1, 1, 0)),
      metrics: [[CONNECTION_SECONDS, 23.1]],
      expectUpdated: true,
      expectedAppMonth: {
        teamID: TEAM2,
        appID: APP1,
        yearMonth: 202301,
        total: {cs: 23.1},
        day: {
          ['1']: {
            total: {cs: 23.1},
            hour: {['0']: {cs: 23.1}},
          },
        },
      },
      expectedTeamMonth: {
        teamID: TEAM2,
        appID: null,
        yearMonth: 202301,
        total: {cs: 23.1},
        day: {
          ['1']: {
            total: {cs: 23.1},
            hour: {['0']: {cs: 23.1}},
          },
        },
      },
      expectedAppTotal: {
        teamID: TEAM2,
        appID: APP1,
        total: {cs: 23.1},
        year: {['2023']: {cs: 23.1}},
      },
      expectedTeamTotal: {
        teamID: TEAM2,
        appID: null,
        total: {cs: 23.1},
        year: {['2023']: {cs: 23.1}},
      },
    },
    {
      name: 'update different day',
      teamID: TEAM2,
      appID: APP1,
      hour: new Date(Date.UTC(2023, 1, 2, 0)),
      metrics: [[CONNECTION_SECONDS, 43.1]],
      expectUpdated: true,
      expectedAppMonth: {
        teamID: TEAM2,
        appID: APP1,
        yearMonth: 202301,
        total: {cs: 66.2},
        day: {
          ['1']: {
            total: {cs: 23.1},
            hour: {['0']: {cs: 23.1}},
          },
          ['2']: {
            total: {cs: 43.1},
            hour: {['0']: {cs: 43.1}},
          },
        },
      },
      expectedTeamMonth: {
        teamID: TEAM2,
        appID: null,
        yearMonth: 202301,
        total: {cs: 66.2},
        day: {
          ['1']: {
            total: {cs: 23.1},
            hour: {['0']: {cs: 23.1}},
          },
          ['2']: {
            total: {cs: 43.1},
            hour: {['0']: {cs: 43.1}},
          },
        },
      },
      expectedAppTotal: {
        teamID: TEAM2,
        appID: APP1,
        total: {cs: 66.2},
        year: {['2023']: {cs: 66.2}},
      },
      expectedTeamTotal: {
        teamID: TEAM2,
        appID: null,
        total: {cs: 66.2},
        year: {['2023']: {cs: 66.2}},
      },
    },
    {
      name: 'update multiple metrics',
      teamID: TEAM1,
      appID: APP2,
      hour: new Date(Date.UTC(2022, 11, 3, 15)),
      metrics: [
        [ROOM_SECONDS, 5.0],
        [CONNECTION_SECONDS, 15.0],
      ],
      expectUpdated: true,
      expectedAppMonth: {
        teamID: TEAM1,
        appID: APP2,
        yearMonth: 202211,
        total: {
          rs: 5.0,
          cs: 15.0,
          cl: 11.1,
        },
        day: {
          ['3']: {
            total: {
              rs: 5.0,
              cs: 15.0,
              cl: 11.1,
            },
            hour: {
              ['15']: {
                rs: 5.0,
                cs: 15.0,
                cl: 11.1,
              },
            },
          },
        },
      },
      expectedTeamMonth: {
        teamID: TEAM1,
        appID: null,
        yearMonth: 202211,
        total: {
          rs: 5.0,
          cs: 15.0,
          cl: 11.1,
        },
        day: {
          ['3']: {
            total: {
              rs: 5.0,
              cs: 15.0,
              cl: 11.1,
            },
            hour: {
              ['15']: {
                rs: 5.0,
                cs: 15.0,
                cl: 11.1,
              },
            },
          },
        },
      },
      expectedAppTotal: {
        teamID: TEAM1,
        appID: APP2,
        total: {
          rs: 5.0,
          cs: 69.14,
          cl: 11.1,
        },
        year: {
          ['2022']: {
            rs: 5.0,
            cs: 15.0,
            cl: 11.1,
          },
          ['2023']: {cs: 54.14},
        },
      },
      expectedTeamTotal: {
        teamID: TEAM1,
        appID: null,
        total: {
          rs: 5.0,
          cs: 79.37,
          cl: 11.1,
        },
        year: {
          ['2022']: {
            rs: 5.0,
            cs: 15.0,
            cl: 11.1,
          },
          ['2023']: {cs: 64.37},
        },
      },
    },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      expect(
        await new Ledger(firestore).set(
          c.teamID,
          c.appID,
          c.hour,
          new Map(c.metrics),
        ),
      ).toBe(c.expectUpdated);
      expect(
        (
          await firestore
            .doc(
              monthMetricsPath(
                c.hour.getUTCFullYear().toString(),
                c.hour.getUTCMonth().toString() as Month,
                c.teamID,
                c.appID,
              ),
            )
            .get()
        ).data(),
      ).toEqual(c.expectedAppMonth);
      expect(
        (
          await firestore
            .doc(
              monthMetricsPath(
                c.hour.getUTCFullYear().toString(),
                c.hour.getUTCMonth().toString() as Month,
                c.teamID,
              ),
            )
            .get()
        ).data(),
      ).toEqual(c.expectedTeamMonth);
      expect(
        (await firestore.doc(totalMetricsPath(c.teamID, c.appID)).get()).data(),
      ).toEqual(c.expectedAppTotal);
      expect(
        (await firestore.doc(totalMetricsPath(c.teamID)).get()).data(),
      ).toEqual(c.expectedTeamTotal);
    });
  }
});
