FROM grafana/grafana-oss:latest
COPY grafana.ini /etc/grafana/grafana.ini
COPY provisioning /etc/grafana/provisioning
# the slab dashboard is also provisioned as the home dashboard
COPY provisioning/dashboards/slab-rack.json /etc/grafana/provisioning/dashboards/slab-rack.json
EXPOSE 3000
