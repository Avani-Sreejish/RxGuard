.PHONY: data up seed eval test loadtest down logs
data:        ## fetch DDInter, NLEM 2022 and ICMR STWs into data/raw (not committed)
	python scripts/download_data.py
up:          ## build and start web + mysql + frontend
	docker compose up -d --build
seed:        ## load KB + corpus + FAISS index into a new KB version and mark it current
	docker compose exec web python manage.py seed
eval:        ## run the 20+ case evaluation and write EVAL_REPORT.md
	docker compose exec web python /app/eval/run.py --out /app/data/processed/EVAL_REPORT.md --labels /app/data/processed/labels_todo.csv
	docker compose cp web:/app/data/processed/EVAL_REPORT.md EVAL_REPORT.md
test:        ## unit + API tests (SQLite, no LLM)
	cd backend && python -m pytest -q
loadtest:    ## Locust run A against $$HOST (see loadtest/README)
	locust -f loadtest/locustfile.py --headless -u 20 -r 5 -t 5m --host $${HOST:-http://localhost:8080} --csv loadtest/results/run_a CheckUser
down:
	docker compose down
logs:
	docker compose logs -f web
