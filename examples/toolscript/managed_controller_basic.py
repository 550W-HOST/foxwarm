def main(args):
    target_session_id = args["target_session_id"]

    lease = open_managed_session(target_session_id)

    event = wait_for_managed_event(
        target_session_id,
        lease["leaseId"],
        lease["revision"],
    )

    result = session_step(
        target_session_id,
        lease["leaseId"],
        event["revision"],
        run_mode="idle",
        inbox_order="before",
        message="Controller handled this request.",
    )
    release = release_managed_session(
        result["sessionId"],
        result["leaseId"],
        result["revision"],
    )
    result["releasedPendingInboxCount"] = release["releasedPendingInboxCount"]

    return {
        "targetSessionId": target_session_id,
        "leaseId": lease["leaseId"],
        "eventRevision": event["revision"],
        "finalRevision": result["revision"],
        "yieldReason": result["yieldReason"],
        "releasedPendingInboxCount": result["releasedPendingInboxCount"],
    }