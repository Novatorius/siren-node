import type { HttpTransport } from '../http';
import type {
  BulkResult,
  Collaborator,
  CollaboratorListParams,
  DeletedResult,
  EnrolledProgram,
  ProgramEnrollment,
  ProgramEnrollmentListParams,
} from '../record-types';
import { SirenError } from '../errors';
import { CollaboratorBulkAction } from '../taxonomy';
import type { SirenList } from '../types';
import { CollaboratorsResource } from './collaborators';
import { bulkRecords, deleteRecord, isJsonObject, listRecords, readObject, recordId, writeRecord } from './record-requests';

/**
 * Collaborator program enrollments: which collaborators take part in which
 * programs.
 *
 * Enrollments have their own route, `/collaborator-programs`, which a
 * connected site's token may use: {@link list}, {@link add} and
 * {@link remove}. A connected site may only enroll a collaborator in, or
 * remove one from, a program that runs on its own Property. Siren answers any
 * other program with a 403 and `program_not_on_site`, raised as
 * `PolicyError`.
 *
 * {@link programsFor}, {@link collaboratorsIn}, {@link enroll},
 * {@link unenroll} and {@link replace} go through the collaborator record and
 * its bulk actions instead, which Siren refuses from a connected site.
 *
 * Reads retry on a network error, 429 or 5xx, so a caller that runs them
 * from its own durable queue builds the client with `maxRetries: 0`.
 * Every write is sent once. Every id must be a positive whole number, and a
 * bad one throws `SirenError` before sending.
 * A write's answer is lost when it throws `ConnectionError` or a 5xx
 * `ApiError`. Siren may have written before the answer failed, so each
 * write says how to find out before sending it again.
 */
export class ProgramEnrollmentsResource {
  /** The route enrollments live on. */
  static readonly PATH = '/collaborator-programs';

  /** The filters {@link list} sends. It refuses any other key. */
  static readonly LIST_FILTERS = ['collaboratorId', 'programId'] as const;
  /** The id filters its list reads, checked before sending: `collaboratorId` and `programId` take one id or a list, each a positive whole number. */
  static readonly ID_FILTERS = { many: ['collaboratorId', 'programId'] } as const;

  constructor(private readonly http: HttpTransport) {}

  /**
   * The programs a collaborator is enrolled in, each `{ id, name }`, read
   * with `GET /collaborators/{id}?fields=id,programs`. Siren always sends
   * the field it was asked for, so a record with no `programs` list, or
   * with an entry that is not an object, throws `UnexpectedResponseError`
   * with the status Siren sent and a message naming `programs` and the
   * collaborator id, never an empty answer. It reads through `readObject`
   * with a `check`.
   */
  async programsFor(collaboratorId: number): Promise<EnrolledProgram[]> {
    const id = recordId(collaboratorId, 'programsFor', 'collaboratorId');
    const record = await readObject<{ programs: EnrolledProgram[] }>(
      this.http,
      `/collaborators/${id}`,
      { fields: 'id,programs' },
      (body) =>
        Array.isArray(body.programs) && body.programs.every(isJsonObject)
          ? undefined
          : `Siren answered collaborator ${id} without a programs list of objects.`,
    );
    return record.programs;
  }

  /**
   * A page of the collaborators enrolled in a program, read with `GET
   * /collaborators` and `programId`. Takes the same parameters as
   * `collaborators.list()` but `programId`, and refuses the same keys. A
   * `programId` in `params` throws `SirenError` before sending.
   */
  async collaboratorsIn(
    programId: number,
    params: Omit<CollaboratorListParams, 'programId'> = {},
  ): Promise<SirenList<Collaborator>> {
    const id = recordId(programId, 'collaboratorsIn', 'programId');
    if (Object.prototype.hasOwnProperty.call(params, 'programId')) {
      throw new SirenError('collaboratorsIn takes the program as its first argument, so params cannot hold programId.');
    }
    return listRecords<Collaborator>(
      this.http,
      '/collaborators',
      { ...params, programId: id },
      CollaboratorsResource.LIST_FILTERS,
      CollaboratorsResource.ID_FILTERS,
    );
  }

  /**
   * Enrolls collaborators in a program, keeping their other enrollments,
   * with the `addToProgram` bulk action: `POST /collaborators/bulk` and
   * body `{ action, ids, programId }`, sent once. Takes 1 to 500 ids.
   * Siren skips an id it cannot find or change and still answers 200, so an
   * `affected` lower than the number of ids sent means some were skipped.
   * Sending it again after a lost answer is safe: Siren skips a collaborator
   * already enrolled, so `affected` may differ from the first send's.
   */
  async enroll(programId: number, collaboratorIds: readonly number[]): Promise<BulkResult> {
    const id = recordId(programId, 'enroll', 'programId');
    return bulkRecords<BulkResult>(this.http, '/collaborators', CollaboratorBulkAction.AddToProgram, collaboratorIds, {
      programId: id,
    });
  }

  /**
   * Removes collaborators from a program, keeping their other enrollments,
   * with the `removeFromProgram` bulk action, sent once. Takes 1 to 500
   * ids. Siren skips an id it cannot find or change and still answers 200,
   * so an `affected` lower than the number of ids sent means some were
   * skipped. Sending it again after a lost answer is safe: a collaborator
   * the first send removed stays removed, though `affected` may differ.
   */
  async unenroll(programId: number, collaboratorIds: readonly number[]): Promise<BulkResult> {
    const id = recordId(programId, 'unenroll', 'programId');
    return bulkRecords<BulkResult>(this.http, '/collaborators', CollaboratorBulkAction.RemoveFromProgram, collaboratorIds, {
      programId: id,
    });
  }

  /**
   * Replaces a collaborator's enrollments with exactly these programs, with
   * `PUT /collaborators/{id}` and body `{ programs }`, sent once. An empty
   * list removes every enrollment. Every program id must be a positive whole
   * number. Answers the updated collaborator.
   * Sending it again after a lost answer sets the same values, so it is safe.
   */
  async replace(collaboratorId: number, programIds: readonly number[]): Promise<Collaborator> {
    const id = recordId(collaboratorId, 'replace', 'collaboratorId');
    if (!Array.isArray(programIds)) {
      throw new SirenError('replace needs a list of program ids.');
    }
    const programs = programIds.map((programId: unknown) => recordId(programId, 'replace', 'programId'));
    return writeRecord<Collaborator>(this.http, 'PUT', `/collaborators/${id}`, { programs });
  }

  /**
   * Lists enrollments with `GET /collaborator-programs`, one row
   * `{ collaboratorId, programId }` per enrollment. Filters, each an exact
   * match: `collaboratorId` and `programId`. A list value matches any of its
   * values. Sort with `orderBy` and `order`.
   * Sends through `listRecords` with {@link LIST_FILTERS} and {@link ID_FILTERS}: any other key
   * and an empty filter list throw `SirenError` before sending, and a 2xx that is not a list throws
   * `UnexpectedResponseError`, never an empty page.
   */
  async list(params: ProgramEnrollmentListParams = {}): Promise<SirenList<ProgramEnrollment>> {
    return listRecords<ProgramEnrollment>(
      this.http,
      ProgramEnrollmentsResource.PATH,
      params,
      ProgramEnrollmentsResource.LIST_FILTERS,
      ProgramEnrollmentsResource.ID_FILTERS,
    );
  }

  /**
   * Enrolls one collaborator in one program with `POST
   * /collaborator-programs` and body `{ collaboratorId, programId }`, sent
   * once. Enrolling someone already enrolled changes nothing and is not an
   * error, so sending it again after a lost answer is safe. Answers
   * `{ collaboratorId, programId }`.
   */
  async add(collaboratorId: number, programId: number): Promise<ProgramEnrollment> {
    const body = {
      collaboratorId: recordId(collaboratorId, 'add', 'collaboratorId'),
      programId: recordId(programId, 'add', 'programId'),
    };
    return writeRecord<ProgramEnrollment>(this.http, 'POST', ProgramEnrollmentsResource.PATH, body);
  }

  /**
   * Ends one enrollment with `DELETE
   * /collaborator-programs?collaboratorId=...&programId=...` and no body,
   * sent once. Removing an enrollment that does not exist is not an error,
   * so sending it again after a lost answer is safe. Answers
   * `{ deleted: true }`.
   */
  async remove(collaboratorId: number, programId: number): Promise<DeletedResult> {
    const query = {
      collaboratorId: recordId(collaboratorId, 'remove', 'collaboratorId'),
      programId: recordId(programId, 'remove', 'programId'),
    };
    await deleteRecord(this.http, ProgramEnrollmentsResource.PATH, query);
    return { deleted: true };
  }
}
