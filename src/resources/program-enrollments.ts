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
import type { SirenList } from '../types';

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
 * Reads retry. Every write is sent once. Every id must be a positive whole
 * number, and a bad one throws `SirenError` before sending.
 */
export class ProgramEnrollmentsResource {
  /** The route enrollments live on. */
  static readonly PATH = '/collaborator-programs';

  constructor(private readonly http: HttpTransport) {}

  /**
   * The programs a collaborator is enrolled in, each `{ id, name }`, read
   * with `GET /collaborators/{id}?fields=id,programs`. Answers an empty
   * array when the record has no `programs` list, and skips any entry that
   * is not an object.
   */
  programsFor(collaboratorId: number): Promise<EnrolledProgram[]> {
    // Stub: slice 3 packet P5
    void collaboratorId;
    void this.http;
    return Promise.resolve([]);
  }

  /**
   * A page of the collaborators enrolled in a program, read with `GET
   * /collaborators` and `programId`. Takes the same parameters as
   * `collaborators.list()`. The `programId` argument wins over one in
   * `params`.
   */
  collaboratorsIn(
    programId: number,
    params: Omit<CollaboratorListParams, 'programId'> = {},
  ): Promise<SirenList<Collaborator>> {
    // Stub: slice 3 packet P5
    void programId;
    void params;
    return Promise.resolve([] as unknown as SirenList<Collaborator>);
  }

  /**
   * Enrolls collaborators in a program, keeping their other enrollments,
   * with the `addToProgram` bulk action: `POST /collaborators/bulk` and
   * body `{ action, ids, programId }`, sent once. Takes 1 to 500 ids.
   */
  enroll(programId: number, collaboratorIds: readonly number[]): Promise<BulkResult> {
    // Stub: slice 3 packet P5
    void programId;
    void collaboratorIds;
    return Promise.resolve({});
  }

  /**
   * Removes collaborators from a program, keeping their other enrollments,
   * with the `removeFromProgram` bulk action, sent once. Takes 1 to 500 ids.
   */
  unenroll(programId: number, collaboratorIds: readonly number[]): Promise<BulkResult> {
    // Stub: slice 3 packet P5
    void programId;
    void collaboratorIds;
    return Promise.resolve({});
  }

  /**
   * Replaces a collaborator's enrollments with exactly these programs, with
   * `PUT /collaborators/{id}` and body `{ programs }`, sent once. An empty
   * list removes every enrollment. Every program id must be a positive whole
   * number. Answers the updated collaborator.
   */
  replace(collaboratorId: number, programIds: readonly number[]): Promise<Collaborator> {
    // Stub: slice 3 packet P5
    void collaboratorId;
    void programIds;
    return Promise.resolve({ id: 1 });
  }

  /**
   * Lists enrollments with `GET /collaborator-programs`, one row
   * `{ collaboratorId, programId }` per enrollment. Filters, each an exact
   * match: `collaboratorId` and `programId`. A list value matches any of its
   * values. Sort with `orderBy` and `order`.
   */
  list(params: ProgramEnrollmentListParams = {}): Promise<SirenList<ProgramEnrollment>> {
    // Stub: slice 3 packet P5
    void params;
    return Promise.resolve([] as unknown as SirenList<ProgramEnrollment>);
  }

  /**
   * Enrolls one collaborator in one program with `POST
   * /collaborator-programs` and body `{ collaboratorId, programId }`, sent
   * once. Enrolling someone already enrolled changes nothing and is not an
   * error. Answers `{ collaboratorId, programId }`.
   */
  add(collaboratorId: number, programId: number): Promise<ProgramEnrollment> {
    // Stub: slice 3 packet P5
    void collaboratorId;
    void programId;
    return Promise.resolve({ collaboratorId: 1, programId: 1 });
  }

  /**
   * Ends one enrollment with `DELETE
   * /collaborator-programs?collaboratorId=...&programId=...` and no body,
   * sent once. Removing an enrollment that does not exist is not an error.
   * Answers `{ deleted: true }`.
   */
  remove(collaboratorId: number, programId: number): Promise<DeletedResult> {
    // Stub: slice 3 packet P5
    void collaboratorId;
    void programId;
    return Promise.resolve({ deleted: false });
  }
}
