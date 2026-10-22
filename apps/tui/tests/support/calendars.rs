use super::*;

#[tokio::test]
#[ignore = "native host/client and Node; real isolated calendar process and recurring job, no model calls"]
async fn recurring_calendars_use_real_helper_and_preserve_cli_mcp_restart_intent() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        let owner=client(&fixture.pairing()).await?;
        let profile=json!({"program":"claude","workspace":"shared","harness":true,"allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]});
        let cron=json!({"title":"Calendar API parity","instruction":"report-task","profile":profile,"schedule":{"kind":"cron","expression":"0 12 * * *"}});
        let file=fixture.directory.join("calendar łódź.json");std::fs::write(&file,serde_json::to_vec(&cron)?)?;
        let created=budgets::owner_cli(&fixture,&["job","create","--key","cron-parity","--file",file.to_str().context("cron file")?,"--json"]).await?;
        assert_eq!(created["data"]["job"]["schedule"]["timeZone"],"Europe/Warsaw");
        assert_eq!(created["data"]["job"]["calendarState"],"ready");
        let replay=data(call(&owner,"nesvo_create_job",json!({"key":"cron-parity","spec":cron})).await?)?;
        assert_eq!(replay["data"],created["data"]);
        let cron_id=created["data"]["job"]["id"].as_str().context("cron ID")?;
        data(call(&owner,"nesvo_set_job_enabled",json!({"key":"pause-cron","jobId":cron_id,"expectedRevision":1,"enabled":false})).await?)?;
        let mut invalid=cron.clone();invalid["schedule"]["timeZone"]="Mars/Olympus".into();
        let denied=call(&owner,"nesvo_create_job",json!({"key":"invalid-zone","spec":invalid})).await?.structured_content.context("invalid calendar")?;
        assert_eq!(denied["error"]["code"],"invalid_calendar");
        let mut expensive=cron.clone();expensive["schedule"]=json!({"kind":"rrule","rule":"FREQ=MINUTELY;BYSECOND=0;BYSETPOS=2","start":"2026-01-01T00:00:00","timeZone":"UTC"});
        let bounded=call(&owner,"nesvo_create_job",json!({"key":"bounded-search","spec":expensive})).await.context("Bounded real helper refusal")?.structured_content.context("calendar bound")?;
        ensure!(bounded["error"]["code"]=="calendar_timeout"||bounded["error"]["code"]=="calendar_limit","Explicit calendar refusal: {bounded}");
        let sessions=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        assert!(sessions["data"]["sessions"].as_array().context("no calendar model effects")?.is_empty());
        let due=chrono::Utc::now()+chrono::Duration::seconds(10);
        let spec=json!({"title":"One finite recurrence","instruction":"report-task","profile":profile,"schedule":{"kind":"rrule","rule":"FREQ=MINUTELY;COUNT=1","start":due.format("%Y-%m-%dT%H:%M:%S").to_string(),"timeZone":"UTC"},"graceMs":60000});
        std::fs::write(&file,serde_json::to_vec(&spec)?)?;
        let scheduled=budgets::owner_cli(&fixture,&["job","create","--key","finite-recurring","--file",file.to_str().context("RRULE file")?,"--json"]).await?;
        let id=scheduled["data"]["job"]["id"].as_str().context("recurring ID")?.to_owned();
        ensure!(chrono::Utc::now()<due,"Disconnect before calendar due");owner.cancel().await?;
        let admission_closes=scheduled["data"]["job"]["nextDueAt"].as_i64().context("Published calendar due")?+spec["graceMs"].as_i64().context("Published grace window")?;
        let callers=fixture.directory.join("callers");
        let launched=|suffix:&str|->Result<bool>{Ok(std::fs::read_dir(&callers)?.filter_map(|e|e.ok()).any(|e|e.file_name().to_string_lossy().ends_with(suffix)))};
        let mut trail=waits::Trail::new(format!("job {id} recurring report with owner clients closed"));
        let reported=waits::until(async || {
            if launched(".result.json")? {return Ok(Some(()));}
            ensure!(fixture.host.try_wait()?.is_none(),"Owned host exited before the recurring report");
            let worker=launched(".launch-argv.json")?;
            trail.observe(json!({"workerLaunched":worker,"result":"absent","admissionOpen":chrono::Utc::now().timestamp_millis()<=admission_closes}));
            ensure!(chrono::Utc::now().timestamp_millis()<=admission_closes||worker,"Recurring occurrence launched no worker within its published admission window");
            Ok(None)
        }).await;
        if let Err(error)=reported {
            let diagnostics=job_diagnostics::report_timeout_diagnostics(&mut fixture,&id).await;
            return Err(error.context(format!("Recurring job reported with owner clients closed; bounded actual diagnostics: {}",diagnostics.to_string().chars().take(12288).collect::<String>())));
        }
        let owner=client(&fixture.pairing()).await?;
        let history=waits::history_occurrence(&owner,&id,0,"needsValidation").await?;
        assert_eq!(history["data"]["occurrences"].as_array().context("one exact occurrence")?.len(),1);
        let current=data(call(&owner,"nesvo_get_job",json!({"jobId":id})).await?)?;
        assert_eq!(current["data"]["job"]["calendarState"],"exhausted");
        assert!(current["data"]["job"]["nextDueAt"].is_null());
        let replay=data(call(&owner,"nesvo_create_job",json!({"key":"finite-recurring","spec":spec})).await?)?;
        assert_eq!(replay["data"],scheduled["data"]);
        run_checkpoints::schema(vec![created,scheduled,replay,history,current]).await?;
        owner.cancel().await?;fixture.restart(false).await?;
        let owner=client(&fixture.pairing()).await?;
        let sessions=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        assert!(sessions["data"]["sessions"].as_array().context("No recurrence restart retry")?.is_empty());
        let history=data(call(&owner,"nesvo_get_job_history",json!({"jobId":id})).await?)?;
        assert_eq!(history["data"]["occurrences"].as_array().context("retained occurrence")?.len(),1);
        owner.cancel().await?;Ok::<_,anyhow::Error>(())
    }).catch_unwind().await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result?;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}
